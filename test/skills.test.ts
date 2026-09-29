// src/skills.ts: finds the bundled plugin skills in a published copy, else in the synclayer sources.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { bundledSkillPaths } from '../src/skills.ts'

test('in synclayer, the skills come from both plugin sources, without the plan skills', () => {
	const names = bundledSkillPaths().map((path) => basename(path))
	assert.ok(names.includes('create-research'))
	assert.ok(names.includes('show-me'))
	assert.ok(!names.includes('create-plan'))
	assert.ok(!names.includes('iterate-plan'))
})

test('a published copy uses its own skills folder, and skips a plugin it lacks', () => {
	const root = mkdtempSync(join(tmpdir(), 'pi-hl-skills-'))
	const pkg = join(root, 'pkg')
	for (const name of ['greet', 'create-plan']) {
		mkdirSync(join(pkg, 'skills', 'rpi', name), { recursive: true })
		writeFileSync(join(pkg, 'skills', 'rpi', name, 'SKILL.md'), '')
	}
	mkdirSync(join(pkg, 'skills', 'rpi', 'no-skill-file'))
	mkdirSync(join(root, 'riptide-rpi-claude-plugin', 'skills'), { recursive: true })
	assert.deepEqual(bundledSkillPaths(pathToFileURL(`${pkg}/`)), [join(pkg, 'skills', 'rpi', 'greet')])
})
