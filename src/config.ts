// Channels, origins and on-disk paths under HUMANLAYER_RIPTIDE_HOME. See plan.md §2.

import { homedir } from 'node:os'
import { join } from 'node:path'

import { errorMessage, logLine, readJsonFile, writeJsonFileAtomic } from './util.ts'

export type Channel = 'prod' | 'beta' | 'dev' | 'local'

export const ALL_CHANNELS: readonly Channel[] = ['prod', 'beta', 'dev', 'local']

export function isChannel(value: string | undefined): value is Channel {
	return value !== undefined && (ALL_CHANNELS as readonly string[]).includes(value)
}

interface ChannelDefaults {
	api: string
	sync: string
	app: string
	clientId: string
}

const CHANNEL_DEFAULTS: Record<Channel, ChannelDefaults> = {
	prod: {
		api: 'https://riptide-api.humanlayer.com',
		sync: 'https://sync.humanlayer.com',
		app: 'https://app.humanlayer.com',
		clientId: 'client_01KGBPX6V78MDGNF006SE6NYTG',
	},
	beta: {
		api: 'https://riptide-api.codelayer.cloud',
		sync: 'https://sync.codelayer.cloud',
		app: 'https://app.codelayer.cloud',
		clientId: 'client_01K84ASX66BNXTMD842AHWBKNG',
	},
	dev: {
		api: 'https://riptide-api.dev.codelayer.gg',
		sync: 'https://sync.dev.codelayer.gg',
		app: 'https://app.dev.codelayer.gg',
		clientId: 'client_01K84ASWYHMC34NMFHN6MBXP8N',
	},
	local: {
		api: 'http://localhost:8700',
		sync: 'http://localhost:8888',
		app: 'http://localhost:3000',
		clientId: 'client_01K84ASWYHMC34NMFHN6MBXP8N', // same as dev: local stacks use the dev WorkOS client
	},
}

const DEFAULT_WORKOS_URL = 'https://api.workos.com'

export interface ChannelConfig {
	channel: Channel
	api: string
	sync: string
	app: string
	workos: string
	clientId: string
}

/** Resolved origins for a channel, with HUMANLAYER_*_URL env overrides applied (tests, local stacks). */
export function getChannelConfig(channel: Channel): ChannelConfig {
	const base = CHANNEL_DEFAULTS[channel]
	return {
		channel,
		api: process.env.HUMANLAYER_API_URL || base.api,
		sync: process.env.HUMANLAYER_SYNC_URL || base.sync,
		app: process.env.HUMANLAYER_APP_URL || base.app,
		workos: process.env.HUMANLAYER_WORKOS_URL || DEFAULT_WORKOS_URL,
		clientId: base.clientId,
	}
}

function riptideHome(): string {
	return process.env.HUMANLAYER_RIPTIDE_HOME || join(homedir(), '.humanlayer', 'riptide')
}

function piDir(): string {
	return join(riptideHome(), 'pi')
}

export function configFilePath(): string {
	return join(piDir(), 'config.json')
}

export function hostFilePath(channel: Channel): string {
	return join(piDir(), `host-${channel}.json`)
}

export function sessionFilePath(channel: Channel): string {
	return join(piDir(), `session-${channel}.json`)
}

export function sessionLockPath(channel: Channel): string {
	return join(piDir(), `session-${channel}.json.lock`)
}

export function bindingsDir(channel: Channel): string {
	return join(piDir(), 'bindings', channel)
}

/** A task's files, shared with the riptide daemon. `<cwd>/.humanlayer/tasks/<slug>` links here. */
export function artifactsDir(taskId: string): string {
	return join(riptideHome(), 'artifacts', taskId)
}

export function logFilePath(): string {
	return join(piDir(), 'logs', 'pi-humanlayer.log')
}

/** Appends a timestamped line to the log file. Best effort; never throws. */
export function log(line: string): void {
	logLine(logFilePath(), `${new Date().toISOString()} ${line}`)
}

/** Runs fn, logging instead of throwing: for work whose failure must not reach pi. */
export function guard<T>(name: string, fn: () => T): T | undefined {
	try {
		return fn()
	} catch (err) {
		log(`${name}: ${errorMessage(err)}`)
		return undefined
	}
}

/** HUMANLAYER_CHANNEL, then config.json's saved channel, then prod. */
export async function resolveChannel(): Promise<Channel> {
	const envChannel = process.env.HUMANLAYER_CHANNEL
	if (isChannel(envChannel)) return envChannel
	const saved = await readJsonFile<{ channel?: string }>(configFilePath())
	if (isChannel(saved?.channel)) return saved.channel
	return 'prod'
}

export async function saveChannel(channel: Channel): Promise<void> {
	await writeJsonFileAtomic(configFilePath(), { channel })
}

export function isDisabled(): boolean {
	return process.env.HUMANLAYER_PI_DISABLE === '1'
}

/** The codingAgent value sent to prepare. The contract defaults to "codelayer", so always send one. */
export function codingAgent(): string {
	return process.env.HUMANLAYER_PI_CODING_AGENT || 'pi'
}

/** HUMANLAYER_TASK: a task id or slug to attach new bindings to. */
export function taskFromEnv(): string | undefined {
	return process.env.HUMANLAYER_TASK?.trim() || undefined
}

/** How long session_shutdown waits for the outbox to drain. */
export function flushMs(): number {
	const ms = Number.parseInt(process.env.HUMANLAYER_PI_FLUSH_MS ?? '', 10)
	return ms >= 0 ? ms : 5000
}

/** How often the host heartbeat beats. riptide-daemon beats every 15 s; the web app calls a host stale after 30 s. */
export function heartbeatMs(): number {
	const ms = Number.parseInt(process.env.HUMANLAYER_PI_HEARTBEAT_MS ?? '', 10)
	return ms > 0 ? ms : 15_000
}
