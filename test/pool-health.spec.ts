/**
 * Pool health bookkeeping: failure classification (which error codes switch
 * members, with what cooldown, and which rethrow) and the cooldown registry
 * (expiry, longest-cooldown-wins, per-provider clear).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  AUTH_COOLDOWN_MS,
  classifyPoolFailure,
  DEFAULT_QUOTA_COOLDOWN_MS,
  memberKey,
  PoolHealthRegistry,
  providerKey,
  TRANSIENT_COOLDOWN_MS,
} from '../src/providers/pool-health.js'

test('classifyPoolFailure: quota and rate-limit cool the whole provider (account-level quota)', () => {
  assert.deepEqual(classifyPoolFailure(new LlmError('quota', 'QUOTA'), 'codex'), {
    action: 'switch',
    cooldownMs: DEFAULT_QUOTA_COOLDOWN_MS,
    reason: 'QUOTA',
    scope: 'provider',
  })
  assert.deepEqual(classifyPoolFailure(new LlmError('limited', 'RATE_LIMIT'), 'grok'), {
    action: 'switch',
    cooldownMs: DEFAULT_QUOTA_COOLDOWN_MS,
    reason: 'RATE_LIMIT',
    scope: 'provider',
  })
})

test('classifyPoolFailure: claude quota failures stay member-scoped (per-model lanes)', () => {
  assert.deepEqual(classifyPoolFailure(new LlmError('quota', 'QUOTA'), 'claude'), {
    action: 'switch',
    cooldownMs: DEFAULT_QUOTA_COOLDOWN_MS,
    reason: 'QUOTA',
    scope: 'member',
  })
})

test('classifyPoolFailure: the provider retry-after wins over the default cooldown', () => {
  const error = new LlmError('slow down', 'RATE_LIMIT', { providerRetryAfterMs: 42_000 })
  assert.deepEqual(classifyPoolFailure(error, 'codex'), {
    action: 'switch',
    cooldownMs: 42_000,
    reason: 'RATE_LIMIT',
    scope: 'provider',
  })
})

test('classifyPoolFailure: auth failures park the provider until re-login', () => {
  for (const code of ['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL']) {
    assert.deepEqual(classifyPoolFailure(new LlmError('denied', code), 'claude'), {
      action: 'switch',
      cooldownMs: AUTH_COOLDOWN_MS,
      reason: code,
      scope: 'provider',
    })
  }
})

test('classifyPoolFailure: transient server failures cool the member briefly', () => {
  for (const code of ['SERVER', 'TIMEOUT', 'EMPTY_RESPONSE']) {
    assert.deepEqual(classifyPoolFailure(new LlmError('oops', code), 'codex'), {
      action: 'switch',
      cooldownMs: TRANSIENT_COOLDOWN_MS,
      reason: code,
      scope: 'member',
    })
  }
})

test('classifyPoolFailure: transport failures switch without a health record', () => {
  assert.deepEqual(classifyPoolFailure(new LlmError('dns', 'TRANSPORT'), 'codex'), { action: 'switch' })
})

test('classifyPoolFailure: request-fault and unknown failures rethrow', () => {
  for (const code of ['CONTEXT_WINDOW_EXCEEDED', 'ABORTED', 'HTTP_400']) {
    assert.deepEqual(classifyPoolFailure(new LlmError('bad request', code), 'codex'), { action: 'throw' })
  }
  assert.deepEqual(classifyPoolFailure(new Error('plain'), 'codex'), { action: 'throw' })
  assert.deepEqual(classifyPoolFailure('string failure', 'codex'), { action: 'throw' })
})

test('PoolHealthRegistry: members cool down and recover on expiry', () => {
  const registry = new PoolHealthRegistry()
  const key = memberKey('codex', 'gpt-5.4')
  assert.equal(registry.isAvailable(key, 1000), true)
  registry.markUnavailable(key, 5000, 'QUOTA', 1000)
  assert.equal(registry.isAvailable(key, 5999), false)
  assert.equal(registry.isAvailable(key, 6000), true)
})

test('PoolHealthRegistry: a longer existing cooldown wins', () => {
  const registry = new PoolHealthRegistry()
  const key = memberKey('claude', 'claude-sonnet-5')
  registry.markUnavailable(key, 10_000, 'QUOTA', 0)
  registry.markUnavailable(key, 1000, 'SERVER', 0)
  assert.equal(registry.isAvailable(key, 5000), false)
  assert.equal(registry.isAvailable(key, 10_000), true)
})

test('PoolHealthRegistry: a provider-wide record parks every member of the provider', () => {
  const registry = new PoolHealthRegistry()
  registry.markUnavailable(providerKey('codex'), 60_000, 'RATE_LIMIT', 0)
  assert.equal(registry.isMemberAvailable('codex', 'gpt-5.4', 1000), false)
  assert.equal(registry.isMemberAvailable('codex', 'gpt-5.4-mini', 1000), false)
  assert.equal(registry.isMemberAvailable('claude', 'claude-sonnet-5', 1000), true)
  assert.equal(registry.isMemberAvailable('codex', 'gpt-5.4', 60_000), true)
})

test('PoolHealthRegistry: earliestRecovery reports the soonest expiry among the given keys', () => {
  const registry = new PoolHealthRegistry()
  const keys = new Set([memberKey('codex', 'a'), memberKey('claude', 'b')])
  assert.equal(registry.earliestRecovery(keys, 0), undefined)
  registry.markUnavailable(memberKey('codex', 'a'), 9000, 'QUOTA', 0)
  registry.markUnavailable(memberKey('claude', 'b'), 3000, 'QUOTA', 0)
  assert.equal(registry.earliestRecovery(keys, 0), 3000)
  // Expired records are dropped, not reported.
  assert.equal(registry.earliestRecovery(keys, 5000), 9000)
})

test('PoolHealthRegistry: earliestRecovery ignores records outside the given keys', () => {
  const registry = new PoolHealthRegistry()
  registry.markUnavailable(memberKey('grok', 'other-pool-member'), 1000, 'QUOTA', 0)
  registry.markUnavailable(memberKey('codex', 'a'), 9000, 'QUOTA', 0)
  const keys = new Set([memberKey('codex', 'a'), providerKey('codex')])
  // The unrelated pool's sooner recovery must not shape this pool's hint.
  assert.equal(registry.earliestRecovery(keys, 0), 9000)
})

test('PoolHealthRegistry: clear drops only the named provider, including its provider-wide record', () => {
  const registry = new PoolHealthRegistry()
  registry.markUnavailable(memberKey('codex', 'a'), 60_000, 'AUTH', 0)
  registry.markUnavailable(providerKey('codex'), 60_000, 'AUTH', 0)
  registry.markUnavailable(memberKey('claude', 'c'), 60_000, 'AUTH', 0)
  registry.clear('codex')
  assert.equal(registry.isMemberAvailable('codex', 'a', 0), true)
  assert.equal(registry.isMemberAvailable('codex', 'b', 0), true)
  assert.equal(registry.isMemberAvailable('claude', 'c', 0), false)
})
