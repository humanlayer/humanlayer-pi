// The HumanLayer tools riptide-daemon gives its agents (plan-part-2.md phase 1), as pi tools.
// Names, descriptions and output text copy riptide-daemon's
// src/agents/shared/humanlayer-tools/{schemas,executors}.ts, so skills and habits carry over.
// Each call goes to the daemon plane with this host's daemon token (api.ts), for the bound task.

import { type Static, type TSchema, Type } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import {
	type ArtifactComment,
	type CommentUpdateResult,
	type DaemonPath,
	type DaemonRequest,
	type DaemonResponse,
	type DiffComment,
	type DiffThread,
	daemonCall,
} from './api.ts'
import type { Channel } from './config.ts'
import { RpcError } from './rpc.ts'
import { sleepUnref } from './util.ts'

/** What a tool needs from the Mirror: the bound task, or why there is none. `pending` while prepare runs. */
export type ToolTarget = { channel: Channel; taskId: string } | { reason: string; pending?: boolean }

/** How long a tool waits for a pending bind: a new session's first prompt may call one at once. */
const BIND_WAIT_MS = 15_000

// ---- output text, as riptide-daemon's executors.ts writes it ----

function formatThread(comment: ArtifactComment, replies: Map<string, ArtifactComment[]>): string {
	const lines = [`<comment id="${comment.truncatedId}">`]
	if (comment.previousBlockText || comment.quotedText || comment.nextBlockText) {
		for (const line of comment.previousBlockText?.split('\n') ?? []) lines.push(`  | ${line}`)
		for (const line of comment.quotedText?.split('\n') ?? []) lines.push(`> | ${line}`)
		for (const line of comment.nextBlockText?.split('\n') ?? []) lines.push(`  | ${line}`)
		lines.push('')
	}
	lines.push(`${comment.userName}${comment.isResolved ? ' [RESOLVED]' : ''}: ${comment.contentText}`)
	for (const reply of replies.get(comment.id) ?? []) {
		lines.push(`  ${reply.userName}${reply.isResolved ? ' [RESOLVED]' : ''}: ${reply.contentText}`)
	}
	lines.push('</comment>')
	return lines.join('\n')
}

export function formatArtifactComments(
	filename: string,
	comments: ArtifactComment[],
	offset: number,
	limit: number,
): string {
	const page = comments.slice(offset, offset + limit)
	if (page.length === 0) return `No comments found on ${filename}`
	const replies = new Map<string, ArtifactComment[]>()
	for (const c of page) {
		if (!c.replyToCommentId) continue
		const list = replies.get(c.replyToCommentId) ?? []
		list.push(c)
		replies.set(c.replyToCommentId, list)
	}
	const threads = page.filter((c) => !c.replyToCommentId).map((c) => formatThread(c, replies))
	const result = `<comments for="${filename}">\n${threads.join('\n\n')}\n</comments>`
	const remaining = Math.max(0, comments.length - offset - page.length)
	return remaining > 0 ? `${result}\n(${remaining} additional comments not returned)` : result
}

function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;')
}

function formatDiffEntry(tag: 'comment' | 'reply', c: DiffComment): string {
	const author = c.createdByAgent ? `${c.createdByUserId}'s agent` : c.createdByUserId
	const text = c.isDeleted ? 'Comment deleted' : c.contentText
	return `  <${tag} id="${c.truncatedId}" author="${escapeXml(author)}">${escapeXml(text)}</${tag}>`
}

export function formatDiffComments(threads: DiffThread[], offset: number, limit: number): string {
	const page = threads.slice(offset, offset + limit)
	if (page.length === 0) return 'No diff comments found for this task'
	const blocks = page.map((t) => {
		const a = t.anchor
		return [
			`<diff_comment id="${t.root.truncatedId}" repo="${escapeXml(a.repoId)}" path="${escapeXml(a.path)}" patch_hash="${escapeXml(a.patchHash)}" start_side="${a.start.side}" start_line="${a.start.line}" end_side="${a.end.side}" end_line="${a.end.line}" resolved="${t.isResolved}">`,
			formatDiffEntry('comment', t.root),
			...t.replies.map((r) => formatDiffEntry('reply', r)),
			'</diff_comment>',
		].join('\n')
	})
	const result = `<diff_comments>\n${blocks.join('\n')}\n</diff_comments>`
	const remaining = Math.max(0, threads.length - offset - page.length)
	return remaining > 0 ? `${result}\n(${remaining} additional threads not returned)` : result
}

function formatUpdate(result: CommentUpdateResult): string {
	const messages: string[] = []
	if (result.updated.length > 0) messages.push(`Updated ${result.updated.length} comment(s)`)
	if (result.failed.length > 0) {
		messages.push(`Failed: ${result.failed.map((f) => `${f.truncatedId}: ${f.reason}`).join(', ')}`)
	}
	return messages.join('. ') || 'No changes made'
}

/** An oRPC error's `data.validArtifacts`, when the artifact was not found. */
function validArtifacts(err: unknown): string[] | undefined {
	if (!(err instanceof RpcError) || typeof err.data !== 'object' || err.data === null) return undefined
	const list = (err.data as { validArtifacts?: unknown }).validArtifacts
	return Array.isArray(list) ? list.map(String) : undefined
}

// ---- the tools ----

/** A daemon call for the bound task's channel, with the tool call's abort signal. */
type Call = <P extends DaemonPath>(path: P, body: DaemonRequest<P>) => Promise<DaemonResponse<P>>

interface Tool {
	description: string
	parameters: TSchema
	run: (params: unknown, taskId: string, call: Call) => Promise<string>
}

/** One tool. pi checks params against the schema before execute, so the cast holds. */
function tool<T extends TSchema>(
	description: string,
	parameters: T,
	run: (p: Static<T>, taskId: string, call: Call) => Promise<string>,
): Tool {
	return { description, parameters, run: (params, taskId, call) => run(params as Static<T>, taskId, call) }
}

const DiffSuffix = Type.String({
	minLength: 8,
	maxLength: 12,
	pattern: '^[0-9a-fA-F]+$',
	description: 'Unique 8-12 character right-hand UUID suffix from get_diff_comments',
})

const paging = (what: string) => ({
	limit: Type.Optional(Type.Integer({ minimum: 1, description: `Max ${what} to return (default: 20)` })),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: `Number of ${what} to skip (default: 0)` })),
})

function requireChange(p: { resolved?: boolean; deleted?: boolean }): void {
	if (p.resolved === undefined && p.deleted === undefined) {
		throw new Error('At least one of resolved or deleted must be provided')
	}
}

const TOOLS = {
	get_artifact_comments: tool(
		'Get all comments on an artifact (plan.md, research.md, etc). Returns threaded comments in XML format with truncated IDs for referencing in update/reply tools.',
		Type.Object({
			artifact_filename: Type.String({ description: 'Filename of the artifact, e.g. "plan.md", "research.md"' }),
			include_resolved: Type.Optional(Type.Boolean({ description: 'Include resolved comments (default: true)' })),
			...paging('comments'),
		}),
		async (p, taskId, call) => {
			const out = await call('comments/get', {
				taskId,
				artifactFilename: p.artifact_filename,
				includeResolved: p.include_resolved ?? true,
			})
			return formatArtifactComments(out.artifactFilename, out.comments, p.offset ?? 0, p.limit ?? 20)
		},
	),
	update_artifact_comments: tool(
		'Update comments on an artifact - mark as resolved or deleted. Use truncated IDs from get_artifact_comments.',
		Type.Object({
			artifact_filename: Type.String({ description: 'Filename of the artifact, e.g. "plan.md"' }),
			comment_ids: Type.Array(Type.String(), {
				minItems: 1,
				description: 'Truncated comment IDs (last 12 chars)',
			}),
			resolved: Type.Optional(Type.Boolean({ description: 'Set resolved state for all specified comments' })),
			deleted: Type.Optional(Type.Boolean({ description: 'Set deleted state for all specified comments' })),
		}),
		async (p, taskId, call) => {
			requireChange(p)
			const body = { taskId, artifactFilename: p.artifact_filename, truncatedCommentIds: p.comment_ids }
			return formatUpdate(await call('comments/update', { ...body, resolved: p.resolved, deleted: p.deleted }))
		},
	),
	reply_to_artifact_comment: tool(
		'Reply to a comment on an artifact. Use truncated ID from get_artifact_comments.',
		Type.Object({
			artifact_filename: Type.String({ description: 'Filename of the artifact, e.g. "plan.md"' }),
			comment_id: Type.String({ description: 'Truncated comment ID to reply to' }),
			content: Type.String({ minLength: 1, description: 'Reply text content (markdown supported)' }),
		}),
		async (p, taskId, call) => {
			const out = await call('comments/reply', {
				taskId,
				artifactFilename: p.artifact_filename,
				truncatedCommentId: p.comment_id,
				contentText: p.content,
			})
			return `Reply added (id: ${out.commentId.slice(-12)})`
		},
	),
	get_diff_comments: tool(
		'Get ordered diff comment threads for the current task, including code anchors and exact short IDs for reply and update tools.',
		Type.Object({
			include_resolved: Type.Optional(Type.Boolean({ description: 'Include resolved threads (default: false)' })),
			...paging('threads'),
		}),
		async (p, taskId, call) => {
			const out = await call('diffComments/get', { taskId, includeResolved: p.include_resolved ?? false })
			return formatDiffComments(out.comments, p.offset ?? 0, p.limit ?? 20)
		},
	),
	reply_to_diff_comment: tool(
		'Reply to a diff comment thread in the current task. The reply is added to the root thread and reopens it.',
		Type.Object({
			thread_id: Type.String({
				...DiffSuffix,
				description: 'Root or reply ID suffix for the thread to reply to',
			}),
			content: Type.String({ minLength: 1, description: 'Reply text content (Markdown supported)' }),
		}),
		async (p, taskId, call) => {
			const out = await call('diffComments/reply', {
				taskId,
				truncatedCommentId: p.thread_id,
				contentText: p.content.trim(),
			})
			return `Reply added (id: ${out.commentId.slice(-12)})`
		},
	),
	update_diff_comments: tool(
		'Resolve, reopen, or soft-delete diff comments in the current task. Resolve a thread only when the user asks you to resolve it or feedback delivery used Send & Resolve. Never resolve a thread just because you replied or changed code. Deletion is limited to comments authored by the driving user.',
		Type.Object({
			comment_ids: Type.Array(DiffSuffix, {
				minItems: 1,
				description: 'Comment or thread ID suffixes to update',
			}),
			resolved: Type.Optional(
				Type.Boolean({ description: 'Resolve (true) or reopen (false) each matched thread' }),
			),
			deleted: Type.Optional(
				Type.Literal(true, { description: 'Soft-delete matched comments authored by the driving user' }),
			),
		}),
		async (p, taskId, call) => {
			requireChange(p)
			const body = { taskId, truncatedCommentIds: p.comment_ids }
			return formatUpdate(
				await call('diffComments/update', { ...body, resolved: p.resolved, deleted: p.deleted }),
			)
		},
	),
	library_researcher: tool(
		'Research documentation for a library or package to answer questions about usage, APIs, and best practices. Use this when you need up-to-date information about a library or dependency.',
		Type.Object({
			question: Type.String({
				description:
					'The specific question you want answered about the library. Be detailed and specific. ' +
					"Good: 'How do I configure authentication middleware in Express.js 5?' " +
					"Bad: 'express auth'",
			}),
			package_name: Type.String({
				description:
					'The exact name of the npm package, PyPI package, or library to research. ' +
					'Use the canonical package name as it appears in the package registry if possible. ' +
					"Examples: 'react', 'express', 'drizzle-orm', '@tanstack/react-query'",
			}),
			language: Type.String({
				description:
					'The programming language(s) in question. E.g. typescript, python, elixir, java, javascript, C, c++, etc',
			}),
		}),
		async (p, _taskId, call) => {
			const out = await call('agents/research', {
				question: p.question,
				packageName: p.package_name,
				language: p.language,
			})
			return out.response
		},
	),
}

type ToolName = keyof typeof TOOLS

/** The tool names, in registration order. */
export const HUMANLAYER_TOOLS = Object.keys(TOOLS) as readonly ToolName[]

/** The message a failed call gives the model. Throwing marks the tool result as an error. */
function failure(name: ToolName, err: unknown): Error {
	const artifacts = validArtifacts(err)
	if (artifacts) return new Error(`Artifact not found. Valid artifacts: ${artifacts.join(', ')}`)
	if (err instanceof RpcError) return new Error(`${name} failed: ${err.message}`)
	return err instanceof Error ? err : new Error(String(err))
}

/** The target once any pending bind has settled, or BIND_WAIT_MS has passed. */
async function settledTarget(target: () => ToolTarget, signal: AbortSignal | undefined): Promise<ToolTarget> {
	const deadline = Date.now() + BIND_WAIT_MS
	let t = target()
	while ('pending' in t && t.pending && Date.now() < deadline && !signal?.aborted) {
		await sleepUnref(100)
		t = target()
	}
	return t
}

/**
 * Registers the tools. `target` names the bound task at call time. Tools are registered once and
 * switched on or off with syncTools() as the session links to a task or stops mirroring.
 */
export function registerHumanlayerTools(pi: ExtensionAPI, target: () => ToolTarget): void {
	for (const name of HUMANLAYER_TOOLS) {
		const { description, parameters, run } = TOOLS[name]
		pi.registerTool({
			name,
			label: name.replaceAll('_', ' '),
			description,
			parameters,
			// A reply reopens its thread, so a reply and a resolve in one turn must land in order.
			executionMode: 'sequential',
			async execute(_id, params, signal) {
				const t = await settledTarget(target, signal)
				if ('reason' in t) throw new Error(t.reason)
				const call: Call = (path, body) => daemonCall(t.channel, path, body, signal)
				try {
					const text = await run(params, t.taskId, call)
					return { content: [{ type: 'text', text }], details: undefined }
				} catch (err) {
					throw failure(name, err)
				}
			},
		})
	}
}

/** Turns the tools on while `on`, off otherwise, leaving every other tool as it is. */
export function syncTools(pi: ExtensionAPI, on: boolean): void {
	const active = pi.getActiveTools()
	const ours = new Set<string>(HUMANLAYER_TOOLS)
	const has = active.some((t) => ours.has(t))
	if (on === has) return
	pi.setActiveTools(on ? [...active, ...HUMANLAYER_TOOLS] : active.filter((t) => !ours.has(t)))
}
