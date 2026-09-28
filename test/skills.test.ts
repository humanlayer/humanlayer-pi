// src/skills.ts: picks the newest version of each riptide plugin and returns its skills dir.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { latestVersion, pluginSkillPaths } from '../src/skills.ts'

test('latestVersion compares numerically and skips temp dirs', () => {
	const root = mkdtempSync(join(tmpdir(), 'pi-hl-skills-'))
	for (const name of ['0.9.0', '0.41.2', '0.41.10', '.riptide-rpi-temp-abc']) mkdirSync(join(root, name))
	assert.equal(latestVersion(root), '0.41.10')
	assert.equal(latestVersion(join(root, 'missing')), undefined)
})

test('pluginSkillPaths returns skills dirs for installed plugins only', () => {
	const root = mkdtempSync(join(tmpdir(), 'pi-hl-skills-'))
	mkdirSync(join(root, 'riptide-rpi', '0.40.0', 'skills'), { recursive: true })
	mkdirSync(join(root, 'riptide-rpi', '0.41.2', 'skills'), { recursive: true })
	mkdirSync(join(root, 'riptide-humanlayer', '0.1.3'), { recursive: true })
	assert.deepEqual(pluginSkillPaths(root), [join(root, 'riptide-rpi', '0.41.2', 'skills')])
})
