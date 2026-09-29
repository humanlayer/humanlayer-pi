// src/skills.ts: finds the bundled plugin skills in a published copy, else in the synclayer sources.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { bundledSkillPaths } from '../src/skills.ts'

test('in synclayer, the skills come from both plugin sources', () => {
	const paths = bundledSkillPaths()
	assert.equal(paths.length, 2)
	assert.ok(existsSync(join(paths[0] ?? '', 'create-plan', 'SKILL.md')))
	assert.ok(existsSync(join(paths[1] ?? '', 'show-me', 'SKILL.md')))
})

test('a published copy uses its own skills folder, and skips a plugin it lacks', () => {
	const root = mkdtempSync(join(tmpdir(), 'pi-hl-skills-'))
	const pkg = join(root, 'pkg')
	mkdirSync(join(pkg, 'skills', 'rpi'), { recursive: true })
	mkdirSync(join(root, 'riptide-rpi-claude-plugin', 'skills'), { recursive: true })
	assert.deepEqual(bundledSkillPaths(pathToFileURL(`${pkg}/`)), [join(pkg, 'skills', 'rpi')])
})
