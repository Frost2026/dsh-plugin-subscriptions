/**
 * Unit tests for the collapsible default-effort section's pure derivation:
 * which models become rows, the counts the collapsed header reports, when the
 * name filter appears, and what the filter matches. No DOM and no React —
 * `deriveModelDefaultsView` is the whole contract the section renders from.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveModelDefaultsView } from '../src/client/SubscriptionsSection.js'
import type { ModelDefaultView } from '../src/client/SubscriptionsSection.js'

/** One catalog entry; `configured` present only when an override is set. */
function model(id: string, name: string, efforts: string[], configured?: string): ModelDefaultView {
  return {
    id,
    name,
    efforts: efforts.map(effort => ({ id: effort, name: effort })),
    ...configured === undefined ? {} : { configured },
  }
}

/** A catalog of `count` reasoning models named `m0…`, plus optional dead ones. */
function catalog(count: number, withoutEfforts = 0): ModelDefaultView[] {
  return [
    ...Array.from({ length: count }, (_, index) => model(`m${index}`, `Model ${index}`, ['low', 'high'])),
    ...Array.from({ length: withoutEfforts }, (_, index) => model(`d${index}`, `Dead ${index}`, [])),
  ]
}

test('a loading catalog derives an empty section rather than throwing', () => {
  const view = deriveModelDefaultsView(undefined, '')
  assert.deepEqual(view, { shown: [], total: 0, overridden: 0, withoutEfforts: 0, showFilter: false })
})

test('only models with reasoning levels become rows; the rest ride as one count', () => {
  const view = deriveModelDefaultsView(catalog(2, 3), '')
  assert.deepEqual(view.shown.map(entry => entry.id), ['m0', 'm1'])
  assert.equal(view.total, 2, 'the header total counts reasoning models only')
  assert.equal(view.withoutEfforts, 3, 'three dead models collapse into one count line')
})

test('the header counts the configured overrides, not the effective defaults', () => {
  const models = [
    model('a', 'A', ['low', 'high'], 'high'),
    model('b', 'B', ['low', 'high']),
    // An advertised default with no override must not count as overridden.
    { ...model('c', 'C', ['low', 'high']), effective: 'low' },
    // A dead model can never be overridden, so it stays out of both counts.
    model('d', 'D', [], 'high'),
  ]
  const view = deriveModelDefaultsView(models, '')
  assert.equal(view.total, 3)
  assert.equal(view.overridden, 1)
  assert.equal(view.withoutEfforts, 1)
})

test('the filter box appears only past the threshold, counting reasoning models', () => {
  assert.equal(deriveModelDefaultsView(catalog(8), '').showFilter, false, '8 models still scan fine')
  assert.equal(deriveModelDefaultsView(catalog(9), '').showFilter, true)
  // Dead models pad the catalog but never earn a filter: they are one line.
  assert.equal(deriveModelDefaultsView(catalog(3, 40), '').showFilter, false)
})

test('the filter matches display name or model id, case- and space-insensitively', () => {
  const models = [
    model('gpt-5.6-sol', 'GPT-5.6 Sol', ['low']),
    model('claude-sonnet-5', 'Claude Sonnet 5', ['low']),
    model('claude-opus-5', 'Claude Opus 5', ['low']),
  ]
  assert.deepEqual(
    deriveModelDefaultsView(models, '  SONNET ').shown.map(entry => entry.id),
    ['claude-sonnet-5'],
    'the query is trimmed and lowercased before matching',
  )
  assert.deepEqual(
    deriveModelDefaultsView(models, 'claude-').shown.map(entry => entry.id),
    ['claude-sonnet-5', 'claude-opus-5'],
    'the id matches even when the display name does not contain the query',
  )
  assert.deepEqual(deriveModelDefaultsView(models, 'gpt').shown.map(entry => entry.id), ['gpt-5.6-sol'])
})

test('a filter that matches nothing empties the rows but keeps the header counts', () => {
  const view = deriveModelDefaultsView(catalog(9, 2), 'no-such-model')
  assert.deepEqual(view.shown, [], 'the list renders the empty-filter notice instead of rows')
  assert.equal(view.total, 9, 'the header still reports the unfiltered total')
  assert.equal(view.withoutEfforts, 2)
  assert.equal(view.showFilter, true, 'the filter box must not vanish under its own query')
})

test('a blank filter is not a query: every reasoning model stays shown', () => {
  const models = catalog(3)
  assert.equal(deriveModelDefaultsView(models, '   ').shown.length, 3)
})
