// Credentials (plan.md §3): the PAT or the saved device login, the access token kept fresh, and
// the daemon token. login.ts writes the saved login; this module reads and refreshes it.

import { randomUUID } from 'node:crypto'

import { type Channel, hostFilePath, sessionFilePath, sessionLockPath } from './config.ts'
import { isTokenRefused, LoginRequiredError, rpc, RpcError } from './rpc.ts'
import { decodeJwtPayload, jwtClaim, readJsonFile, withFileLock, writeJsonFileAtomic } from './util.ts'

export interface Creds {
	version: 1
	channel: Channel
	email: string
	userId: string
	orgId: string // internal org uuid (access JWT's internal_org_id); the daemon token carries this one
	workosOrgId: string // WorkOS org id ("org_..."; access JWT's org_id); pins auth/token/refresh
	orgName: string
	accessToken: string
	refreshToken: string
	daemonToken: string
	daemonHostId: string
}

/** This machine's host id for the channel, made once and kept across logout (plan.md §2). */
export async function hostId(channel: Channel): Promise<string> {
	const existing = await readJsonFile<{ hostId: string }>(hostFilePath(channel))
	if (existing && typeof existing.hostId === 'string' && existing.hostId.length > 0) return existing.hostId
	const hostId = randomUUID()
	await writeJsonFileAtomic(hostFilePath(channel), { hostId })
	return hostId
}

// The scrubbed PAT (and its derived daemon tokens) are the one exception to losing module
// state on /reload: they live on globalThis, keyed as plan.md §1 specifies.
const GLOBAL_STASH_KEY = Symbol.for('humanlayer.pi.v1')

interface GlobalStash {
	pat?: string
	patDaemonTokens?: Partial<Record<Channel, string>>
}

function stash(): GlobalStash {
	const saved: GlobalStash | undefined = Reflect.get(globalThis, GLOBAL_STASH_KEY)
	if (saved) return saved
	const fresh: GlobalStash = {}
	Reflect.set(globalThis, GLOBAL_STASH_KEY, fresh)
	return fresh
}

/** Reads HUMANLAYER_PAT once, then deletes it from process.env so children never see it. */
export function getPat(): string | undefined {
	const s = stash()
	if (s.pat === undefined) {
		const fromEnv = process.env.HUMANLAYER_PAT
		if (fromEnv !== undefined) {
			s.pat = fromEnv
			delete process.env.HUMANLAYER_PAT
		}
	}
	return s.pat
}

export interface Identity {
	channel: Channel
	source: 'device' | 'pat'
	email?: string
	orgName?: string
	orgId?: string
	userId?: string
}

export async function identity(channel: Channel): Promise<Identity | null> {
	if (getPat()) return { channel, source: 'pat' }
	const creds = await readJsonFile<Creds>(sessionFilePath(channel))
	if (!creds) return null
	return {
		channel,
		source: 'device',
		email: creds.email,
		orgName: creds.orgName,
		orgId: creds.orgId,
		userId: creds.userId,
	}
}

function isFresh(creds: Creds): boolean {
	const claims = decodeJwtPayload(creds.accessToken)
	const exp = typeof claims.exp === 'number' ? claims.exp : 0
	return exp * 1000 - Date.now() > 60_000 // plan.md §3: refresh within 60s of exp
}

const NOT_SIGNED_IN_MESSAGE = 'Not signed in to HumanLayer. Run /humanlayer login'

async function refreshAndSave(channel: Channel, current: Creds): Promise<string> {
	let refreshed: { accessToken: string; refreshToken: string }
	try {
		refreshed = await rpc<{ accessToken: string; refreshToken: string }>(channel, 'api', 'auth/token/refresh', {
			refreshToken: current.refreshToken,
			organizationId: current.workosOrgId,
		})
	} catch (err) {
		// auth/token/refresh is public and returns 400 BAD_REQUEST "Failed to refresh token" on
		// any failure (expired, revoked, reused); treat a 401 the same way defensively.
		if (err instanceof RpcError && (err.status === 400 || err.status === 401)) {
			throw new LoginRequiredError('HumanLayer sign-in expired. Run /humanlayer login')
		}
		throw err
	}
	const updated: Creds = { ...current, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken }
	await writeJsonFileAtomic(sessionFilePath(channel), updated)
	return updated.accessToken
}

/** Refreshes only if within 60s of exp (plan.md §3). Re-reads under the lock first. */
async function refreshAccessToken(channel: Channel): Promise<string> {
	const first = await readJsonFile<Creds>(sessionFilePath(channel))
	if (!first) throw new LoginRequiredError(NOT_SIGNED_IN_MESSAGE)
	if (isFresh(first)) return first.accessToken
	return withFileLock(sessionLockPath(channel), async () => {
		const current = await readJsonFile<Creds>(sessionFilePath(channel))
		if (!current) throw new LoginRequiredError(NOT_SIGNED_IN_MESSAGE)
		if (isFresh(current)) return current.accessToken // another process refreshed first
		return refreshAndSave(channel, current)
	})
}

/** Unconditional refresh used after a live 401, skipped if another process already refreshed staleToken. */
async function refreshAccessTokenFrom(channel: Channel, staleToken: string): Promise<string> {
	return withFileLock(sessionLockPath(channel), async () => {
		const current = await readJsonFile<Creds>(sessionFilePath(channel))
		if (!current) throw new LoginRequiredError(NOT_SIGNED_IN_MESSAGE)
		if (current.accessToken !== staleToken) return current.accessToken // another process refreshed first
		return refreshAndSave(channel, current)
	})
}

/**
 * Calls an API-plane route with the PAT or the device access token. On a 401 from an
 * already-"fresh" token, refreshes once and retries once (plan.md §3). A PAT cannot be
 * refreshed, so a 401 on it means the PAT itself is invalid or revoked: login required.
 */
export async function apiRpc<T>(channel: Channel, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
	const pat = getPat()
	// A refresh is never aborted: the server may have spent the refresh token already.
	const bearer = pat ?? (await refreshAccessToken(channel))
	try {
		return await rpc<T>(channel, 'api', path, body, bearer, signal)
	} catch (err) {
		if (pat) {
			if (err instanceof RpcError && err.status === 401) {
				throw new LoginRequiredError('HUMANLAYER_PAT was rejected (401). Set a valid HUMANLAYER_PAT.')
			}
			throw err
		}
		if (!(err instanceof RpcError) || err.status !== 401) throw err
		const retried = await refreshAccessTokenFrom(channel, bearer)
		return rpc<T>(channel, 'api', path, body, retried, signal)
	}
}

async function mintDaemonToken(channel: Channel, hostId: string, signal?: AbortSignal): Promise<string> {
	const minted = await apiRpc<{ token: string }>(channel, 'auth/daemon/token/create', { hostId }, signal)
	return minted.token
}

async function remintPatDaemonToken(channel: Channel, signal?: AbortSignal): Promise<string> {
	if (!getPat()) throw new LoginRequiredError('HUMANLAYER_PAT not set')
	const token = await mintDaemonToken(channel, await hostId(channel), signal)
	const s = stash()
	if (!s.patDaemonTokens) s.patDaemonTokens = {}
	s.patDaemonTokens[channel] = token
	return token
}

async function patDaemonToken(channel: Channel, signal?: AbortSignal): Promise<string> {
	const cached = stash().patDaemonTokens?.[channel]
	if (cached) return cached
	return remintPatDaemonToken(channel, signal)
}

export async function daemonToken(channel: Channel, signal?: AbortSignal): Promise<string> {
	if (getPat()) return patDaemonToken(channel, signal)
	const creds = await readJsonFile<Creds>(sessionFilePath(channel))
	if (!creds) throw new LoginRequiredError(NOT_SIGNED_IN_MESSAGE)
	return creds.daemonToken
}

/** The internal org uuid the daemon token carries, if it has one. */
export async function daemonOrgId(channel: Channel, signal?: AbortSignal): Promise<string | undefined> {
	return jwtClaim(await daemonToken(channel, signal), 'organizationId')
}

/**
 * Mints a new daemon token and saves it. The mint may refresh and save the access token, and
 * another process may refresh, remint, log in or log out meanwhile, so the save re-reads under
 * the lock and keeps a token someone else saved. The lock is not held across the mint: a
 * refresh takes the same lock.
 */
export async function remintDaemonToken(channel: Channel, signal?: AbortSignal): Promise<string> {
	if (getPat()) return remintPatDaemonToken(channel, signal)
	const before = await readJsonFile<Creds>(sessionFilePath(channel))
	if (!before) throw new LoginRequiredError(NOT_SIGNED_IN_MESSAGE)
	const token = await mintDaemonToken(channel, before.daemonHostId, signal)
	return withFileLock(sessionLockPath(channel), async () => {
		const current = await readJsonFile<Creds>(sessionFilePath(channel))
		if (!current) throw new LoginRequiredError(NOT_SIGNED_IN_MESSAGE)
		if (current.daemonToken !== before.daemonToken) return current.daemonToken
		await writeJsonFileAtomic(sessionFilePath(channel), { ...current, daemonToken: token })
		return token
	})
}

/**
 * Runs a daemon-plane request with the daemon token, and once more with a fresh token when the
 * cloud refuses the first (plan.md §3). A second refusal is thrown: classifyRpcError reads it as
 * login required.
 */
export async function withDaemonToken<T>(
	channel: Channel,
	signal: AbortSignal | undefined,
	request: (token: string) => Promise<T>,
): Promise<T> {
	try {
		return await request(await daemonToken(channel, signal))
	} catch (err) {
		if (!isTokenRefused(err)) throw err
		return request(await remintDaemonToken(channel, signal))
	}
}
