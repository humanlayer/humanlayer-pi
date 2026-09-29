// Offers the skills of HumanLayer's rpi and humanlayer plugins to pi, so `/skill:create-plan` and
// friends work in pi as they do in HumanLayer sessions, with no HumanLayer app installed.
// The preview repo ships them in `skills/`; in synclayer they are read from the plugin sources.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PACKAGE = new URL('../', import.meta.url)

/** Per plugin: its folder in a published copy, then its source folder in synclayer. */
export const SKILL_SOURCES = [
	['skills/rpi', '../riptide-rpi-claude-plugin/skills'],
	['skills/humanlayer', '../riptide-humanlayer-claude-plugin/skills'],
] as const

/** The skills folder of each plugin, from the first place it exists. */
export function bundledSkillPaths(root: URL = PACKAGE): string[] {
	const paths: string[] = []
	for (const places of SKILL_SOURCES) {
		const found = places.map((place) => fileURLToPath(new URL(place, root))).find((path) => existsSync(path))
		if (found) paths.push(found)
	}
	return paths
}
