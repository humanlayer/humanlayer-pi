// Offers the skills of the riptide plugins the daemon installs (rpi, humanlayer) to pi, so
// `/skill:create-plan` and friends work in pi as they do in HumanLayer sessions. Only the
// newest installed version of each plugin counts; a missing plugin is skipped.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { pluginsDir } from './config.ts'

const PLUGINS = ['riptide-rpi', 'riptide-humanlayer']

function parseVersion(name: string): number[] | undefined {
	if (!/^\d+(\.\d+)*$/.test(name)) return undefined
	return name.split('.').map(Number)
}

function compareVersions(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0)
		if (diff !== 0) return diff
	}
	return 0
}

/** The newest version directory under a plugin, ignoring temp dirs and other non-version names. */
export function latestVersion(pluginDir: string): string | undefined {
	let names: string[]
	try {
		names = readdirSync(pluginDir)
	} catch {
		return undefined
	}
	let best: { name: string; version: number[] } | undefined
	for (const name of names) {
		const version = parseVersion(name)
		if (version && (!best || compareVersions(version, best.version) > 0)) best = { name, version }
	}
	return best?.name
}

/** `skills` dirs of the newest installed version of each riptide plugin. */
export function pluginSkillPaths(root = pluginsDir()): string[] {
	const paths: string[] = []
	for (const plugin of PLUGINS) {
		const version = latestVersion(join(root, plugin))
		if (!version) continue
		const skills = join(root, plugin, version, 'skills')
		if (existsSync(skills)) paths.push(skills)
	}
	return paths
}
