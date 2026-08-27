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

test('a model named after an Object.prototype member has no configured default', async () => {
  await fresh()
  // Model ids are provider-supplied catalog data used as object keys, so a
  // plain index would inherit from Object.prototype and hand a *function* to
  // mergeReasoning, which then throws and breaks that model's resolution.
  // Reachable only once the provider has any override at all (section exists).
  await setDefaultEffort('codex', 'gpt-5.6-sol', 'high')
  for (const inherited of ['toString', 'valueOf', 'hasOwnProperty', 'constructor']) {
    assert.equal(defaultEffortOf('codex', inherited), undefined, `${inherited} must not resolve`)
    assert.doesNotThrow(() => mergeReasoning(defaultEffortOf('codex', inherited), {
      efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }],
    }))
  }
  assert.equal(defaultEffortOf('codex', 'gpt-5.6-sol'), 'high', 'real overrides still resolve')
})

test('mergeReasoning keeps defaultEffort ∈ efforts through the pool intersection', () => {
  // The DSH runtime rejects an unknown default with INVALID_MODEL_REASONING,
  // and a pooled model's block is the *intersection* across members — so a
  // configured level that only one member advertises must not survive as the
  // pool's default. Mirrors intersectReasoning from providers/pool.ts, which
  // is module-private.
  const intersect = (
    members: readonly (ReturnType<typeof mergeReasoning>)[],
  ): ReturnType<typeof mergeReasoning> => {
    const [first, ...rest] = members
    if (first === undefined) return undefined
    const efforts = first.efforts.filter(effort =>
      rest.every(other => other?.efforts.some(entry => entry.id === effort.id) === true))
    if (efforts.length === 0) return undefined
    const keep = first.defaultEffort !== undefined && efforts.some(effort => effort.id === first.defaultEffort)
    return { efforts, ...keep ? { defaultEffort: first.defaultEffort } : {} }
  }
  const levels = (ids: string[]) => ({ efforts: ids.map(id => ({ id: ReasoningEffortId(id), name: id })) })
  const legal = (block: ReturnType<typeof mergeReasoning>): boolean => block === undefined
    || block.defaultEffort === undefined
    || block.efforts.some(effort => effort.id === block.defaultEffort)

  for (const configured of [undefined, 'ultra', 'low', 'nonexistent']) {
    for (const first of [['low', 'high', 'ultra'], ['low', 'high'], ['x']]) {
      for (const second of [['low', 'high', 'ultra'], ['low', 'medium'], ['x']]) {
        const a = mergeReasoning(configured, levels(first))
        const b = mergeReasoning(configured, levels(second))
        for (const [label, block] of [['a', a], ['b', b], ['pool', intersect([a, b])], ['rev', intersect([b, a])]] as const) {
          assert.ok(legal(block), `${label}: configured=${String(configured)} ${first.join('/')} vs ${second.join('/')}`)
        }
      }
    }
  }
})

test('a hostile file cannot pollute Object.prototype or smuggle in a provider', async () => {
  await fresh()
  writeFileSync(modelDefaultsFilePath(), JSON.stringify({
    __proto__: { polluted: 'yes' },
    evil: { x: 'high' },
    codex: { __proto__: 'high', 'real-model': 'low' },
  }), 'utf8')
  await resetModelDefaultsForTests()
  await loadModelDefaults()
  assert.equal((({}) as Record<string, unknown>).polluted, undefined, 'Object.prototype is untouched')
  assert.deepEqual(
    modelDefaultsSnapshot(),
    { codex: { 'real-model': 'low' } },
    'unknown providers and inherited keys are dropped, real entries survive',
  )
})
