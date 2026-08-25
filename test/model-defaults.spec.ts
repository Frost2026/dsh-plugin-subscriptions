/**
 * Unit tests for the per-model default-effort overrides: the durable store
 * (`model-defaults.json` at a redirected DSH_HOME) and the reasoning-block
 * merge helper shared by the four adapters.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const HOME = mkdtempSync(join(tmpdir(), 'model-defaults-test-'))
process.env.DSH_HOME = HOME

// Imports after the env override so the store path resolves under the temp home.
const {
  defaultEffortOf,
  loadModelDefaults,
  modelDefaultsFilePath,
  modelDefaultsSnapshot,
  resetModelDefaultsForTests,
  setDefaultEffort,
} = await import('../src/model-defaults.js')
const { effortDisplayName, mergeReasoning } = await import('../src/providers/common.js')

/** Wipe the module state and the file between tests. */
async function fresh(): Promise<void> {
  await resetModelDefaultsForTests()
  rmSync(modelDefaultsFilePath(), { force: true })
  await loadModelDefaults()
}

test('an absent file reads as empty: no model has a configured default', async () => {
  await fresh()
  assert.equal(defaultEffortOf('claude', 'claude-sonnet-5'), undefined)
  assert.deepEqual(modelDefaultsSnapshot(), {})
})

test('setDefaultEffort persists the override and serves it from memory', async () => {
  await fresh()
  await setDefaultEffort('claude', 'claude-sonnet-5', 'high')
  assert.equal(defaultEffortOf('claude', 'claude-sonnet-5'), 'high')
  assert.equal(defaultEffortOf('codex', 'gpt-5.6-sol'), undefined)
  assert.deepEqual(modelDefaultsSnapshot(), { claude: { 'claude-sonnet-5': 'high' } })
  const path = modelDefaultsFilePath()
  assert.ok(statSync(path).isFile(), 'the file exists after a write')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).claude['claude-sonnet-5'], 'high')
  // Owner-only permissions, matching the rest of the plugin's durable state.
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('clearing the last override drops the provider section', async () => {
  await fresh()
  await setDefaultEffort('grok', 'grok-4', 'medium')
  await setDefaultEffort('grok', 'grok-4', undefined)
  assert.equal(defaultEffortOf('grok', 'grok-4'), undefined)
  assert.deepEqual(modelDefaultsSnapshot(), {})
  assert.deepEqual(JSON.parse(readFileSync(modelDefaultsFilePath(), 'utf8')), {})
})

test('a malformed file reads as empty and is rewritten by the next save', async () => {
  await fresh()
  writeFileSync(modelDefaultsFilePath(), '{ not json', 'utf8')
  await resetModelDefaultsForTests()
  await loadModelDefaults()
  assert.equal(defaultEffortOf('claude', 'claude-sonnet-5'), undefined)
  await setDefaultEffort('claude', 'claude-sonnet-5', 'max')
  assert.equal(defaultEffortOf('claude', 'claude-sonnet-5'), 'max')
})

test('a malformed provider section is dropped wholesale, others survive', async () => {
  await fresh()
  writeFileSync(modelDefaultsFilePath(), JSON.stringify({
    claude: { 'claude-sonnet-5': 'high', broken: 42 },
    codex: { 'gpt-5.6-sol': 'low' },
    unknown: { 'x': 'y' },
  }), 'utf8')
  await resetModelDefaultsForTests()
  await loadModelDefaults()
  assert.equal(defaultEffortOf('claude', 'claude-sonnet-5'), undefined)
  assert.equal(defaultEffortOf('codex', 'gpt-5.6-sol'), 'low')
})

test('effortDisplayName spells xhigh out', () => {
  assert.equal(effortDisplayName('xhigh'), 'Extra High')
  assert.equal(effortDisplayName('low'), 'Low')
})

test('mergeReasoning: a configured default wins over the advertised one', () => {
  const base = {
    efforts: [
      { id: ReasoningEffortId('low'), name: 'Low' },
      { id: ReasoningEffortId('high'), name: 'High' },
    ],
    defaultEffort: ReasoningEffortId('low'),
  }
  const merged = mergeReasoning('high', base)
  assert.equal(merged?.defaultEffort, 'high')
  assert.deepEqual(merged?.efforts.map(effort => effort.id), ['low', 'high'])
})

test('mergeReasoning: a configured default outside the set is appended', () => {
  const base = {
    efforts: [
      { id: ReasoningEffortId('low'), name: 'Low' },
      { id: ReasoningEffortId('high'), name: 'High' },
    ],
  }
  const merged = mergeReasoning('max', base)
  assert.equal(merged?.defaultEffort, 'max')
  assert.deepEqual(merged?.efforts.map(effort => effort.id), ['low', 'high', 'max'])
  assert.equal(merged?.efforts[2]?.name, 'Max')
})

test('mergeReasoning: no configured default returns the advertised block (fresh copy)', () => {
  const base = {
    efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }],
    defaultEffort: ReasoningEffortId('low'),
  }
  const merged = mergeReasoning(undefined, base)
  assert.deepEqual(merged, base)
  assert.notEqual(merged, base, 'returns a detached block, not the caller object')
})

test('mergeReasoning: a configured default creates a one-level block without a base', () => {
  const merged = mergeReasoning('high', undefined)
  assert.equal(merged?.defaultEffort, 'high')
  assert.deepEqual(merged?.efforts.map(effort => effort.id), ['high'])
})

test('mergeReasoning: nothing configured, nothing discovered, nothing returned', () => {
  assert.equal(mergeReasoning(undefined, undefined), undefined)
})
