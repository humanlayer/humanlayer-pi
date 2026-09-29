// Offers the skills of HumanLayer's rpi and humanlayer plugins to pi, so `/skill:create-research` and
// friends work in pi as they do in HumanLayer sessions, with no HumanLayer app installed.
// The preview repo ships them in `skills/`; in synclayer they are read from the plugin sources.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = new URL('../', import.meta.url)

/** Per plugin: its folder in a published copy, then its source folder in synclayer. */
export const SKILL_SOURCES = [
	['skills/rpi', '../riptide-rpi-claude-plugin/skills'],
	['skills/humanlayer', '../riptide-humanlayer-claude-plugin/skills'],
] as const

/** Plugin skills pi does not offer. */
export const LEFT_OUT = new Set(['create-plan', 'iterate-plan'])

/** Each offered skill's folder, from the first place its plugin exists. pi loads a folder with a SKILL.md as one skill. */
export function bundledSkillPaths(root: URL = PACKAGE): string[] {
	const paths: string[] = []
	for (const places of SKILL_SOURCES) {
		const found = places.map((place) => fileURLToPath(new URL(place, root))).find((path) => existsSync(path))
		if (!found) continue
		for (const name of readdirSync(found).sort()) {
			if (!LEFT_OUT.has(name) && existsSync(join(found, name, 'SKILL.md'))) paths.push(join(found, name))
		}
	}
	return paths
}
