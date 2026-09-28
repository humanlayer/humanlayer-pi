// Small, dependency-free helpers shared by the rest of the extension. Node builtins only.

import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

/** Waits ms without keeping the process alive. An abort ends the wait early, without an error. */
export function sleepUnref(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer)
			signal?.removeEventListener('abort', done)
			resolve()
		}
		const timer = setTimeout(done, ms)
		timer.unref()
		if (signal?.aborted) done()
		else signal?.addEventListener('abort', done, { once: true })
	})
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, 'utf8')) as T
	} catch {
		return null
	}
}

export async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
	await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
	await rename(tmp, path)
}

/** A lock older than this was left by a crash. */
const LOCK_STALE_MS = 30_000
const LOCK_TIMEOUT_MS = 15_000
const LOCK_POLL_MS = 100

/** Runs fn holding a lock file, across processes. */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
	const start = Date.now()
	for (;;) {
		try {
			const handle = await open(lockPath, 'wx', 0o600)
			await handle.close()
			break
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
			const info = await stat(lockPath).catch(() => null)
			const age = Date.now() - (info?.mtimeMs ?? Date.now())
			if (age > LOCK_STALE_MS) await unlink(lockPath).catch(() => {})
			else if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error(`HumanLayer: lock timed out: ${lockPath}`)
			else await sleepUnref(LOCK_POLL_MS)
		}
	}
	try {
		return await fn()
	} finally {
		await unlink(lockPath).catch(() => {})
	}
}

export function sha256Hex(input: string | Uint8Array): string {
	return createHash('sha256').update(input).digest('hex')
}

/** Content hash for artifact dedup: base64url(sha256("'" + s + "'")), ohash-style. */
export function ohash(s: string): string {
	const wrapped = `'${s.replaceAll('\0', '')}'`
	return createHash('sha256').update(wrapped, 'utf8').digest('base64url')
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
	const part = jwt.split('.')[1]
	if (!part) throw new Error('Malformed JWT: no payload segment')
	const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
	if (typeof parsed !== 'object' || parsed === null) throw new Error('Malformed JWT: payload is not an object')
	return parsed as Record<string, unknown>
}

/** A non-empty string claim of a JWT, else undefined, also for a malformed token. */
export function jwtClaim(jwt: string, key: string): string | undefined {
	try {
		const value = decodeJwtPayload(jwt)[key]
		return typeof value === 'string' && value ? value : undefined
	} catch {
		return undefined
	}
}

function formatUuidBytes(bytes: Uint8Array): string {
	const hex = Buffer.from(bytes).toString('hex')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// Fixed namespace for nameUuid below. Arbitrary but constant so the same name always maps
// to the same id.
const NAME_UUID_NAMESPACE = Buffer.from('c7b1b7b063e4de4a9c8a2f6b7a4e9d31', 'hex')

/** Deterministic, UUIDv5-shaped id derived from a name (sha1, not cryptographically secure). */
export function nameUuid(name: string): string {
	const hash = createHash('sha1')
		.update(Buffer.concat([NAME_UUID_NAMESPACE, Buffer.from(name, 'utf8')]))
		.digest()
	const bytes = hash.subarray(0, 16)
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50 // version 5
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80 // variant RFC 4122
	return formatUuidBytes(bytes)
}

/** Truncate a string to at most maxBytes UTF-8 bytes without splitting a multi-byte char. */
export function cutUtf8(s: string, maxBytes: number): string {
	const buf = Buffer.from(s, 'utf8')
	if (buf.byteLength <= maxBytes) return s
	let end = maxBytes
	while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--
	const removed = buf.byteLength - end
	return `${buf.subarray(0, end).toString('utf8')}…[truncated ${removed} bytes]`
}

let logChain: Promise<void> = Promise.resolve()

/** Best-effort append-only logger. Never throws, never logs secrets. Rotates at 5 MB. */
export function logLine(path: string, line: string): void {
	logChain = logChain.then(async () => {
		try {
			const info = await stat(path).catch(() => null)
			if (info && info.size > 5 * 1024 * 1024) await rename(path, `${path}.1`).catch(() => {})
			await mkdir(dirname(path), { recursive: true, mode: 0o700 })
			await appendFile(path, line.endsWith('\n') ? line : `${line}\n`, { mode: 0o600 })
		} catch {
			// logging is best-effort only
		}
	})
}
