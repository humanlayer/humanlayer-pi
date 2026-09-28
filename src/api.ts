// The riptide-api routes this extension calls, typed: what it sends and what it reads back. Only
// the fields the extension uses are here; test/helpers/contracts.ts holds the full zod schemas
// the mock cloud checks requests against. daemonCall() and prepare() add the credentials.

import { apiRpc, withDaemonToken } from './auth.ts'
import type { Channel } from './config.ts'
import type { CloudEvent, UsageUpdate } from './mapper.ts'
import { rpc } from './rpc.ts'

// ---- sessions (sessionId is added by the sender, for the bound session) ----

/** The statuses a daemon reports. The API sets the rest (resuming, interrupt_requested, ...). */
export type SessionStatus = 'running' | 'ready_for_input' | 'interrupted' | 'failed'

export interface SessionUpdate extends Partial<UsageUpdate> {
	status?: SessionStatus
	codingAgentSessionId?: string
	model?: string
	resolvedModel?: string
	contextWindowLimit?: number
	errorMessage?: string
	isCompacting?: boolean
}

export interface RepositoriesReport {
	/** branch is absent on a detached HEAD. */
	repositories: { localPath: string; remoteUrl?: string; branch?: string }[]
}

/** One queued call about the bound session. */
export type SessionCall =
	| { path: 'sessions/update'; body: SessionUpdate }
	| { path: 'sessions/events/create'; body: CloudEvent }
	| { path: 'sessions/repositories/report'; body: RepositoriesReport }

type WithSession<T> = T & { sessionId: string }

// ---- automation/run/prepare (api plane) ----

export interface PrepareSession {
	hostId: string
	sessionName: string
	prompt: string
	workingDirectory: string
	codingAgent: string
	/** provider and model default server-side when absent. */
	provider?: string
	model?: string
	permissionsMode: 'bypass'
}

export interface WorkspaceRepo {
	path: string
	sourceRef: 'HEAD'
	sourceCommit?: string
	branch: string
	primary: true
	remoteUrl?: string
}

export interface TaskConfig {
	name: string
	workflowType: 'freeform'
	worktreeTiming: 'never'
	workspaceState?: { workspaceBaseDirectory: string; repos: WorkspaceRepo[] }
}

export type PrepareBody =
	| (PrepareSession & { taskMode: 'use'; taskIdOrSlug: string })
	| (PrepareSession & { taskMode: 'ensure'; slug: string; task: TaskConfig })

export interface Prepared {
	taskId: string
	userId: string
	sessionId: string
}

// ---- comments and research (the HumanLayer tools) ----

export interface ArtifactComment {
	id: string
	truncatedId: string
	userName: string
	isResolved: boolean
	createdByAgent: boolean
	contentText: string
	quotedText: string | null
	previousBlockText: string | null
	nextBlockText: string | null
	replyToCommentId: string | null
}

export interface DiffComment {
	id: string
	truncatedId: string
	createdByUserId: string
	createdByAgent: boolean
	contentText: string
	isDeleted: boolean
}

export interface DiffThread {
	root: DiffComment
	replies: DiffComment[]
	anchor: {
		repoId: string
		path: string
		patchHash: string
		start: { side: string; line: number }
		end: { side: string; line: number }
	}
	isResolved: boolean
}

export interface CommentUpdateResult {
	updated: unknown[]
	failed: { truncatedId: string; reason: string }[]
}

interface CommentFlags {
	truncatedCommentIds: string[]
	resolved?: boolean
	deleted?: boolean
}

// ---- slash commands for the web composer ----

/** A command the web composer offers for sessions of this agent, host and folder. */
export interface AgentSkill {
	name: string
	description?: string
	scope?: 'user' | 'project' | 'plugin'
}

// ---- the daemon plane ----

/** Each daemon route: [request body, response]. */
interface DaemonRoutes {
	'sessions/update': [WithSession<SessionUpdate>, unknown]
	'sessions/events/create': [WithSession<CloudEvent>, unknown]
	'sessions/repositories/report': [WithSession<RepositoriesReport>, unknown]
	'hosts/heartbeat': [{ hostId: string; hostName: string; capabilities: string[]; canSelfUpdate: boolean }, unknown]
	'artifacts/upsert': [
		{
			taskId: string
			fileName: string
			content: string
			sessionId: string
			operationType: 'Write' | 'Edit'
			operationContents: { path: string; file_path: string }
			frontmatter: Record<string, unknown>
		},
		unknown,
	]
	'artifacts/createUpload': [
		{ taskId: string; fileName: string; contentType: string; contentHash: string; fileSizeBytes: number },
		{ uploadUrl: string },
	]
	'comments/get': [
		{ taskId: string; artifactFilename: string; includeResolved: boolean },
		{ artifactFilename: string; comments: ArtifactComment[] },
	]
	'comments/update': [CommentFlags & { taskId: string; artifactFilename: string }, CommentUpdateResult]
	'comments/reply': [
		{ taskId: string; artifactFilename: string; truncatedCommentId: string; contentText: string },
		{ commentId: string },
	]
	'diffComments/get': [{ taskId: string; includeResolved: boolean }, { comments: DiffThread[] }]
	'diffComments/update': [CommentFlags & { taskId: string }, CommentUpdateResult]
	'diffComments/reply': [{ taskId: string; truncatedCommentId: string; contentText: string }, { commentId: string }]
	'agents/research': [{ question: string; packageName: string; language: string }, { response: string }]
	'agentCommands/report': [
		// Only skills: pi's other commands run in the terminal, not from a web message.
		{ hostId: string; agent: string; workspacePath: string; commands: never[]; skills: AgentSkill[] },
		unknown,
	]
}

export type DaemonPath = keyof DaemonRoutes
export type DaemonRequest<P extends DaemonPath> = DaemonRoutes[P][0]
export type DaemonResponse<P extends DaemonPath> = DaemonRoutes[P][1]

/** One daemon-plane call with this host's daemon token, re-minted once if the cloud refuses it. */
export function daemonCall<P extends DaemonPath>(
	channel: Channel,
	path: P,
	body: DaemonRequest<P>,
	signal?: AbortSignal,
): Promise<DaemonResponse<P>> {
	return withDaemonToken(channel, signal, (token) =>
		rpc<DaemonResponse<P>>(channel, 'daemon', path, body, token, signal),
	)
}

/** Sends a queued session call for the cloud session it belongs to. */
export function sendSessionCall(
	channel: Channel,
	call: SessionCall,
	sessionId: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const body = { ...call.body, sessionId }
	return withDaemonToken(channel, signal, (token) => rpc(channel, 'daemon', call.path, body, token, signal))
}

/** automation/run/prepare, with the signed-in user's bearer. */
export function prepare(channel: Channel, body: PrepareBody, signal?: AbortSignal): Promise<Prepared> {
	return apiRpc<Prepared>(channel, 'automation/run/prepare', body, signal)
}
