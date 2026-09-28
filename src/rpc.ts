// oRPC-style HTTP calls to riptide-api, and how their errors are handled (plan.md §5.5). No
// dependency on auth.ts: callers pass a bearer or daemon token to rpc(). auth.ts adds the tokens.

import { type Channel, getChannelConfig, log } from './config.ts'
import { errorMessage } from './util.ts'

export type Plane = 'api' | 'daemon'

export class RpcError extends Error {
	readonly status: number
	readonly code: string | undefined
	/** The oRPC error's `data`, e.g. `validArtifacts` on a missing artifact. */
	readonly data: unknown

	constructor(message: string, status: number, code: string | undefined, data?: unknown) {
		super(message)
		this.name = 'RpcError'
		this.status = status
		this.code = code
		this.data = data
	}
}

/**
 * Thrown by auth.ts when no bearer can be produced at all: no creds and no PAT, a token
 * refresh itself fails with 400/401 (auth/token/refresh is public and returns 400 on any
 * failure), or the PAT is rejected with a 401. The outbox pauses on this, on either plane,
 * instead of retrying or skipping (plan.md §3, §5.5).
 */
export class LoginRequiredError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'LoginRequiredError'
	}
}

function isErrorBody(json: unknown): json is { code?: string; message?: string; data?: unknown } {
	return typeof json === 'object' && json !== null
}

/** A timeout, cut short when `signal` aborts (the Mirror aborts what is in flight at shutdown). */
export function timeout(ms: number, signal?: AbortSignal): AbortSignal {
	return signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms)
}

/**
 * POST {api}/rpc/{plane}/v1/{path}. `cred` is a bearer (api plane) or raw daemon token (daemon
 * plane). Logs one line per call: the outcome, time and request size, never the body or cred.
 */
export async function rpc<T>(
	channel: Channel,
	plane: Plane,
	path: string,
	body: unknown,
	cred?: string,
	signal?: AbortSignal,
): Promise<T> {
	const headers = new Headers({ 'content-type': 'application/json' })
	if (cred && plane === 'api') headers.set('authorization', `Bearer ${cred}`)
	if (cred && plane === 'daemon') headers.set('x-daemon-authorization', cred)
	const data = JSON.stringify(body ?? {})
	const start = Date.now()
	const note = (outcome: string | number) =>
		log(`${plane} ${path} ${outcome} ${Date.now() - start}ms ${Buffer.byteLength(data)}B`)
	const res = await fetch(`${getChannelConfig(channel).api}/rpc/${plane}/v1/${path}`, {
		method: 'POST',
		headers,
		body: data,
		signal: timeout(15_000, signal),
	}).catch((err: unknown) => {
		note(errorMessage(err))
		throw err
	})
	const json: unknown = await res.json().catch(() => null)
	note(res.status)
	if (!res.ok) {
		const err = isErrorBody(json) ? json : undefined
		throw new RpcError(err?.message ?? `HTTP ${res.status}`, res.status, err?.code, err?.data)
	}
	return json as T
}

export type RpcErrorAction =
	| { kind: 'retry-forever' }
	| { kind: 'retry-limited'; maxAttempts: number }
	| { kind: 'login-required' }
	| { kind: 'stop-all' }
	| { kind: 'stop-binding' }
	| { kind: 'skip' }

/** The cloud refused a daemon token: re-mint it (auth.ts withDaemonToken). */
export function isTokenRefused(err: unknown): boolean {
	return err instanceof RpcError && (err.status === 401 || (err.status === 403 && err.code === 'UNAUTHORIZED'))
}

/**
 * plan.md §5.5's error table, plus LoginRequiredError on either plane (plan.md §3). Daemon calls
 * re-mint a refused token before they throw, so a refusal that reaches here needs a login.
 */
export function classifyRpcError(err: unknown, plane: Plane): RpcErrorAction {
	if (err instanceof LoginRequiredError) return { kind: 'login-required' }
	if (!(err instanceof RpcError)) return { kind: 'retry-forever' } // network failure, no response
	const { status } = err
	if (status === 408 || status === 425 || status === 429 || status === 502 || status === 503 || status === 504) {
		return { kind: 'retry-forever' }
	}
	if (status === 500) return { kind: 'retry-limited', maxAttempts: 5 }
	if (plane === 'daemon' && isTokenRefused(err)) return { kind: 'login-required' }
	if (status === 402) return { kind: 'stop-all' } // any 402, not only BILLING_REQUIRED
	if (status === 403 || status === 404) return { kind: 'stop-binding' }
	return { kind: 'skip' } // 400, 413, 422 and anything else
}

/** Whether the action retries the item, forever or for a while. */
export function isRetry(action: RpcErrorAction): boolean {
	return action.kind === 'retry-forever' || action.kind === 'retry-limited'
}
