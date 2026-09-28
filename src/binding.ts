// A binding links one pi session to one cloud session (plan.md §4). This module picks the task,
// reads local git facts, builds the prepare body, and loads/saves the binding file at
// bindingsDir(channel)/<piSessionId>.json. No network calls here.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import type { PrepareBody, PrepareSession, RepositoriesReport, TaskConfig, WorkspaceRepo } from './api.ts'
import { hostId, type Identity } from './auth.ts'
import { bindingsDir, type Channel, codingAgent, configFilePath, taskFromEnv } from './config.ts'
import { cutUtf8, readJsonFile, writeJsonFileAtomic } from './util.ts'

const execFileAsync = promisify(execFile)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Entries before index n are done. lastId is entry n-1's id, to notice a shifted entry list. */
export interface Cursor {
	n: number
	lastId: string | null
	/** The next user entry is the first prompt, which prepare already wrote. */
	skipFirstUser?: boolean
}

export interface GitInfo {
	root: string
	/** Absent in a repo with no commits yet. */
	headSha?: string
	/** "" on a detached HEAD. */
	branch: string
	/** origin, with any user:password@ removed. */
	remoteUrl?: string
}

export interface Binding {
	version: 1
	channel: Channel
	piSessionId: string
	cwd: string
	createdAt: string
	taskMode: 'ensure' | 'use'
	/** Absent after an attach by uuid: no route reads a task by id. */
	taskSlug?: string
	hostId: string
	/** Acked: moves only when the outbox reaches a cursor marker. */
	cursor: Cursor
	/** Git facts at bind time; the task diff is against headSha. */
	git?: GitInfo
	off?: boolean
	// Set when prepare succeeds. A binding with no cloudSessionId is pending and never saved.
	cloudSessionId?: string
	taskId?: string
	userId?: string
	orgId?: string
	sessionUrl?: string
	/** Task files sent so far (artifacts.ts), by subpath. Written only after the cloud took them. */
	artifactLedger?: Record<string, LedgerEntry>
	/** Task diff rows sent so far (diffs.ts), by path. Written only after the streams took them. */
	diffPublished?: Record<string, { patchHash?: string; rowHash: string }>
}

/** hash: what the cloud stores for the file. mtimeSize: `${mtimeMs}:${size}` when it was read. */
export interface LedgerEntry {
	hash: string
	mtimeSize: string
}

export type TaskPick =
	| { taskMode: 'ensure'; slug: string }
	| { taskMode: 'use'; taskIdOrSlug: string; taskSlug?: string; auto?: boolean }

/** plan.md §4 "Which task": attach, the flag, HUMANLAYER_TASK, the worktree's task link, else create. */
export async function pickTask(piSessionId: string, cwd: string, attach?: string, flag?: string): Promise<TaskPick> {
	// The session's own slug may be an earlier bind's task: `attach new` needs one of its own.
	if (attach === 'new') return newTask(randomUUID())
	const chosen = attach || flag?.trim() || taskFromEnv()
	if (chosen === 'new') return newTask(piSessionId)
	if (chosen) return { taskMode: 'use', taskIdOrSlug: chosen, taskSlug: UUID.test(chosen) ? undefined : chosen }
	const link = await taskLink(cwd)
	if (link) return { taskMode: 'use', taskIdOrSlug: link.taskId, taskSlug: link.slug, auto: true }
	return newTask(piSessionId)
}

/** Stable for first binds, flags and failed auto-attach fallback; explicit attach new passes a fresh id. */
export function newTask(piSessionId: string): Extract<TaskPick, { taskMode: 'ensure' }> {
	return { taskMode: 'ensure', slug: `pi-${piSessionId.replaceAll('-', '').slice(-12)}` }
}

/**
 * A HumanLayer worktree's own task: exactly one `.humanlayer/tasks/<slug>` symlink to
 * `.../artifacts/<uuid>`. Links this extension made (recordLink) don't count, or a later session
 * in the same cwd would join an earlier session's task.
 */
async function taskLink(cwd: string): Promise<{ taskId: string; slug: string } | undefined> {
	const dir = await realpath(join(cwd, '.humanlayer', 'tasks')).catch(() => '')
	let links: { taskId: string; slug: string }[] = []
	for (const name of await readdir(dir).catch(() => [])) {
		const target = await readlink(join(dir, name)).catch(() => '')
		const taskId = /\/artifacts\/([^/]+)\/?$/.exec(target)?.[1]
		if (taskId && UUID.test(taskId)) links.push({ taskId, slug: name })
	}
	if (links.length > 0) {
		const own = new Set((await readFile(linksPath(), 'utf8').catch(() => '')).split('\n'))
		links = links.filter((link) => !own.has(linkKey(join(dir, link.slug), link.taskId)))
	}
	return links.length === 1 ? links[0] : undefined
}

/** Every task link this extension made, as JSON [path, taskId] lines. Only appended to: bindings change, this must not. */
function linksPath(): string {
	return join(dirname(configFilePath()), 'task-links.jsonl')
}

function linkKey(path: string, taskId: string): string {
	return JSON.stringify([path, taskId])
}

/** Notes a link before it exists, using its real parent so cwd aliases share the record. */
export async function recordLink(path: string, taskId: string): Promise<void> {
	const key = linkKey(join(await realpath(dirname(path)), basename(path)), taskId)
	await mkdir(dirname(linksPath()), { recursive: true, mode: 0o700 })
	// A leading newline keeps a partial last write from swallowing the next complete record.
	await appendFile(linksPath(), `\n${key}\n`, { mode: 0o600 })
}

/** Trimmed stdout, or undefined when git fails or exits non-zero. */
export async function git(cwd: string, ...args: string[]): Promise<string | undefined> {
	try {
		return (await execFileAsync('git', args, { cwd, timeout: 5000 })).stdout.trim()
	} catch {
		return undefined
	}
}

/** Local git facts for workspaceState and repositories/report. Undefined outside a repo. */
export async function gitInfo(cwd: string): Promise<GitInfo | undefined> {
	const root = await git(cwd, 'rev-parse', '--show-toplevel')
	if (!root) return undefined
	const [headSha, branch, remoteUrl] = await Promise.all([
		git(root, 'rev-parse', '--verify', '-q', 'HEAD'),
		git(root, 'symbolic-ref', '--short', '-q', 'HEAD'),
		git(root, 'remote', 'get-url', 'origin'),
	])
	const info: GitInfo = { root, branch: branch ?? '' }
	if (headSha) info.headSha = headSha
	if (remoteUrl) info.remoteUrl = stripUserinfo(remoteUrl)
	return info
}

/** Removes user:password@ from URL-style remotes. scp-style "git@host:path" has no secret and stays. */
export function stripUserinfo(url: string): string {
	try {
		const parsed = new URL(url)
		if (!parsed.username && !parsed.password) return url
		parsed.username = ''
		parsed.password = ''
		return parsed.toString()
	} catch {
		return url
	}
}

/** prepare's prompt: the text plus "[image]" per image, cut to 1 MB. Never empty. */
export function promptText(text: string, imageCount: number): string {
	const parts = [text, ...Array.from({ length: imageCount }, () => '[image]')].filter((part) => part.trim())
	return cutUtf8(parts.join('\n'), 1024 * 1024) || '(empty prompt)'
}

/** Task name and sessionName: the pi session name, else the prompt's first line cut to 80 characters. */
export function sessionTitle(sessionName: string | undefined, prompt: string): string {
	const line = prompt.split('\n').find((l) => l.trim()) ?? ''
	return sessionName?.trim() || Array.from(line.trim()).slice(0, 80).join('').trim() || 'pi session'
}

export interface PrepareFacts {
	pick: TaskPick
	hostId: string
	title: string
	prompt: string
	cwd: string
	model?: { provider: string; id: string }
	git?: GitInfo
}

/** The automation/run/prepare body (facts.md). provider and model default server-side when absent. */
export function prepareBody(f: PrepareFacts): PrepareBody {
	const session: PrepareSession = {
		hostId: f.hostId,
		sessionName: f.title,
		prompt: f.prompt,
		workingDirectory: f.cwd,
		codingAgent: codingAgent(),
		permissionsMode: 'bypass',
	}
	if (f.model) {
		session.provider = f.model.provider
		session.model = f.model.id
	}
	if (f.pick.taskMode === 'use') return { ...session, taskMode: 'use', taskIdOrSlug: f.pick.taskIdOrSlug }
	const task: TaskConfig = { name: f.title, workflowType: 'freeform', worktreeTiming: 'never' }
	if (f.git) task.workspaceState = workspaceState(f.git)
	return { ...session, taskMode: 'ensure', slug: f.pick.slug, task }
}

/** For ensure only: the task's workspace is the repo pi runs in. */
function workspaceState(git: GitInfo): NonNullable<TaskConfig['workspaceState']> {
	const repo: WorkspaceRepo = { path: basename(git.root), sourceRef: 'HEAD', branch: git.branch, primary: true }
	if (git.headSha) repo.sourceCommit = git.headSha
	if (git.remoteUrl) repo.remoteUrl = git.remoteUrl
	return { workspaceBaseDirectory: dirname(git.root), repos: [repo] }
}

/** sessions/repositories/report's body, less sessionId. No branch when HEAD is detached. */
export function repositoriesReport(git: GitInfo): RepositoriesReport {
	const repo: RepositoriesReport['repositories'][number] = { localPath: git.root }
	if (git.remoteUrl) repo.remoteUrl = git.remoteUrl
	if (git.branch) repo.branch = git.branch
	return { repositories: [repo] }
}

/** A new, still pending binding: it has no cloud session until prepare succeeds. */
export function newBinding(o: {
	channel: Channel
	piSessionId: string
	cwd: string
	pick: TaskPick
	hostId: string
	cursor: Cursor
	git: GitInfo | undefined
}): Binding {
	const b: Binding = {
		version: 1,
		channel: o.channel,
		piSessionId: o.piSessionId,
		cwd: o.cwd,
		createdAt: new Date().toISOString(),
		taskMode: o.pick.taskMode,
		hostId: o.hostId,
		cursor: o.cursor,
	}
	const slug = o.pick.taskMode === 'ensure' ? o.pick.slug : o.pick.taskSlug
	if (slug) b.taskSlug = slug
	else if (o.pick.taskMode === 'use') b.taskId = o.pick.taskIdOrSlug
	if (o.git) b.git = o.git
	return b
}

function bindingPath(channel: Channel, piSessionId: string): string {
	return join(bindingsDir(channel), `${piSessionId}.json`)
}

/** The saved binding, unless it belongs to another channel or host, or (device login) another user or org. */
export async function loadBinding(
	channel: Channel,
	piSessionId: string,
	who: Identity | null,
): Promise<Binding | undefined> {
	const b = await readJsonFile<Binding>(bindingPath(channel, piSessionId))
	if (b?.version !== 1 || !b.cloudSessionId || b.channel !== channel || b.hostId !== (await hostId(channel)))
		return undefined
	if (who?.source === 'device' && (b.userId !== who.userId || b.orgId !== who.orgId)) return undefined
	return b
}

export async function saveBinding(b: Binding): Promise<void> {
	await writeJsonFileAtomic(bindingPath(b.channel, b.piSessionId), b)
}
