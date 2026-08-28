/**
 * PoolUsageTracker's negative cache: a fetch failure must gate retries the
 * same way a success does, or a progressively rate-limited usage endpoint
 * (Anthropic's `/oauth/usage`: 429 with a `retry-after` that grows on every
 * hit inside the window) never gets a chance to recover — see upstream
 * issue #46. Credential failures are the one exception: they cost no
 * network round trip and must stay live so a fixed login rejoins instantly.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { OAuthEndpointError } from '../src/providers/common.js'
import type { ProviderUsage } from '../src/providers/common.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import type { ProviderId } from '../src/auth/store.js'

const MEMBER = { provider: 'claude' as const, account: 'a1', model: 'claude-opus-5' }

const OK_USAGE: ProviderUsage = { supported: true, windows: [{ kind: 'session', usedPercent: 10 }] }

/** A tracker whose sole fetcher counts calls and answers from a script. */
function trackerOf(
  fetcher: () => Promise<ProviderUsage>,
  ttlMs?: number,
): { tracker: PoolUsageTracker; calls: { count: number } } {
  const calls = { count: 0 }
  const tracker = new PoolUsageTracker(
    (provider: ProviderId, account: string) =>
      provider === MEMBER.provider && account === MEMBER.account
        ? () => { calls.count += 1; return fetcher() }
        : undefined,
    ttlMs,
  )
  return { tracker, calls }
}

test('quotaFor: a 429 with retry-after is cached — the second call within the window skips the network', async () => {
  const error = new OAuthEndpointError('claude usage token endpoint error (HTTP 429)', 429, undefined, 60_000)
  const { tracker, calls } = trackerOf(() => Promise.reject(error))
  const first = await tracker.quotaFor(MEMBER)
  assert.deepEqual(first, { available: true, urgency: 0, fetchedAt: 0 })
  const second = await tracker.quotaFor(MEMBER)
  assert.deepEqual(second, { available: true, urgency: 0, fetchedAt: 0 })
  assert.equal(calls.count, 1, 'the cooling-down failure must not be retried')
})

test('quotaFor: a failure with no retry-after falls back to the default TTL', async () => {
  const { tracker, calls } = trackerOf(() => Promise.reject(new Error('network blip')), 50)
  await tracker.quotaFor(MEMBER)
  await tracker.quotaFor(MEMBER)
  assert.equal(calls.count, 1, 'still within the default TTL')
  await new Promise(resolve => setTimeout(resolve, 60))
  await tracker.quotaFor(MEMBER)
  assert.equal(calls.count, 2, 'the TTL expired, so this call retries')
})

test('quotaFor: a missing/invalid credential is never negative-cached, so recovery is immediate', async () => {
  let broken = true
  const { tracker, calls } = trackerOf(() =>
    broken ? Promise.reject(new LlmError('logged out', 'MISSING_CREDENTIAL')) : Promise.resolve(OK_USAGE))
  const first = await tracker.quotaFor(MEMBER)
  assert.deepEqual(first, { available: false, urgency: 0, fetchedAt: 0 })
  broken = false
  const second = await tracker.quotaFor(MEMBER)
  assert.equal(second.available, true)
  assert.equal(calls.count, 2, 'every call re-checks credentials live, no cooldown')
})

test('quotaFor: a stale success still serves cached data while a background refresh runs', async () => {
  const { tracker, calls } = trackerOf(() => Promise.resolve(OK_USAGE), 10)
  await tracker.quotaFor(MEMBER)
  await new Promise(resolve => setTimeout(resolve, 20))
  const stale = await tracker.quotaFor(MEMBER)
  assert.equal(stale.available, true)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls.count, 2, 'the stale read triggered exactly one background refresh')
})

test('snapshotFor: a live failure cooldown is never bypassed, even by a forced (manual refresh) call', async () => {
  const error = new OAuthEndpointError('claude usage token endpoint error (HTTP 429)', 429, undefined, 60_000)
  const { tracker, calls } = trackerOf(() => Promise.reject(error))
  await assert.rejects(tracker.snapshotFor('claude', 'a1'), error)
  await assert.rejects(tracker.snapshotFor('claude', 'a1', true), error)
  assert.equal(calls.count, 1, 'force must not punch through an active cooldown')
})

test('snapshotFor: force bypasses a fresh SUCCESS cache for an honest re-check', async () => {
  const { tracker, calls } = trackerOf(() => Promise.resolve(OK_USAGE))
  await tracker.snapshotFor('claude', 'a1')
  await tracker.snapshotFor('claude', 'a1')
  assert.equal(calls.count, 1, 'plain calls reuse the fresh cache')
  await tracker.snapshotFor('claude', 'a1', true)
  assert.equal(calls.count, 2, 'a forced call re-fetches regardless of freshness')
})

test('snapshotFor: a provider without a usage fetcher answers supported:false', async () => {
  const tracker = new PoolUsageTracker(() => undefined)
  const usage = await tracker.snapshotFor('grok', 'a1')
  assert.deepEqual(usage, { supported: false })
})
