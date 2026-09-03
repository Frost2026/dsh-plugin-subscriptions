/**
 * Prompt cache routing affinity tests: verify deterministic session headers
 * for Codex (session-id) and Grok (x-grok-conv-id, session-id) to prevent
 * shard-routing cache misses.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deterministicSessionId } from '../src/providers/common.js'
import { CodexAdapter, CODEX_API_URL } from '../src/providers/codex.js'
import { GrokAdapter, GROK_API_URL } from '../src/providers/grok.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { CodexSession, GrokSession } from '../src/auth/store.js'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

test('deterministicSessionId produces valid, deterministic UUIDs', () => {
  const uuid1 = deterministicSessionId('session-abc')
  const uuid2 = deterministicSessionId('session-abc')
  const uuid3 = deterministicSessionId('session-xyz')

  assert.equal(uuid1, uuid2, 'same input must produce identical UUID')
  assert.notEqual(uuid1, uuid3, 'different inputs must produce different UUIDs')
  assert.match(uuid1, UUID_V4_RE, 'output must be a valid UUID format')
  assert.match(uuid3, UUID_V4_RE, 'output must be a valid UUID format')

  const existingUuid = '123e4567-e89b-12d3-a456-426614174000'
  assert.equal(deterministicSessionId(existingUuid), existingUuid, 'pre-existing UUID is preserved')

  const fresh1 = deterministicSessionId(undefined)
  const fresh2 = deterministicSessionId(undefined)
  assert.match(fresh1, UUID_V4_RE)
  assert.match(fresh2, UUID_V4_RE)
  assert.notEqual(fresh1, fresh2, 'empty input produces fresh random UUID')
})

const COMPLETED_SSE = [
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'ok' }] } },
  { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'

function toHeaderRecord(raw: HeadersInit | undefined): Record<string, string> {
  if (!raw) return {}
  if (raw instanceof Headers) {
    const res: Record<string, string> = {}
    raw.forEach((v, k) => { res[k.toLowerCase()] = v })
    return res
  }
  if (Array.isArray(raw)) return Object.fromEntries(raw)
  return { ...(raw as Record<string, string>) }
}

function recordingFetch(): {
  calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[]
  restore(): void
} {
  const original = globalThis.fetch
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: toHeaderRecord(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return Promise.resolve(new Response(COMPLETED_SSE))
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

const SessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

const TEST_OPTIONS: GenerateOptions = {
  provider: 'codex',
  model: 'gpt-5.6',
  messages: [{
    id: MessageId('m1'),
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }],
}

const codexSession: CodexSession = {
  accessToken: 'tok-codex',
  refreshToken: 'ref-codex',
  accountId: 'acc-1',
  expiresAt: Date.now() + 3600_000,
}

const grokSession: GrokSession = {
  accessToken: 'tok-grok',
  refreshToken: 'ref-grok',
  tokenEndpoint: 'https://auth.x.ai/token',
  expiresAt: Date.now() + 3600_000,
}

function memoryTokens<T>(session: T) {
  return {
    session: () => Promise.resolve(session),
    list: () => Promise.resolve([]),
    defaultAccount: () => Promise.resolve(undefined),
  }
}

test('Codex sends deterministic session-id header across requests in same session', async () => {
  const { calls, restore } = recordingFetch()
  try {
    const adapter = new CodexAdapter({
      models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }],
      streamIdleTimeoutMs: 1000,
      tokens: memoryTokens(codexSession) as any,
      discovery: false,
    })

    const opt1 = { ...TEST_OPTIONS, sessionId: SessionId('my-session-42') }
    for await (const chunk of adapter.stream(opt1)) void chunk
    for await (const chunk of adapter.stream(opt1)) void chunk

    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.url, CODEX_API_URL)
    assert.equal(calls[1]?.url, CODEX_API_URL)

    const header0 = calls[0]?.headers['session-id']
    const header1 = calls[1]?.headers['session-id']
    assert.ok(header0, 'session-id header must be present')
    assert.equal(header0, header1, 'repeat calls for the same session must reuse the exact same session-id header')
    assert.match(header0, UUID_V4_RE, 'session-id header must be an RFC-4122 v4 UUID')
  } finally {
    restore()
  }
})

test('Grok sends x-grok-conv-id and session-id headers for cache routing', async () => {
  const { calls, restore } = recordingFetch()
  try {
    const adapter = new GrokAdapter({
      models: [{ id: 'grok-4', name: 'Grok 4' }],
      streamIdleTimeoutMs: 1000,
      tokens: memoryTokens(grokSession) as any,
      discovery: false,
    })

    const opt = { ...TEST_OPTIONS, provider: 'grok', model: 'grok-4', sessionId: SessionId('grok-conv-123') }
    for await (const chunk of adapter.stream(opt)) void chunk

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, GROK_API_URL)
    const convHeader = calls[0]?.headers['x-grok-conv-id']
    const sessHeader = calls[0]?.headers['session-id']

    assert.ok(convHeader, 'x-grok-conv-id header must be present')
    assert.ok(sessHeader, 'session-id header must be present')
    assert.equal(convHeader, sessHeader, 'both affinity headers must match')
    assert.match(convHeader, UUID_V4_RE, 'header must be an RFC-4122 v4 UUID')
  } finally {
    restore()
  }
})

test('Grok omits cache routing headers when sessionId is absent', async () => {
  const { calls, restore } = recordingFetch()
  try {
    const adapter = new GrokAdapter({
      models: [{ id: 'grok-4', name: 'Grok 4' }],
      streamIdleTimeoutMs: 1000,
      tokens: memoryTokens(grokSession) as any,
      discovery: false,
    })

    const opt = { ...TEST_OPTIONS, provider: 'grok', model: 'grok-4' }
    for await (const chunk of adapter.stream(opt)) void chunk

    assert.equal(calls.length, 1)
    assert.ok(!('x-grok-conv-id' in (calls[0]?.headers ?? {})), 'must not send x-grok-conv-id without sessionId')
    assert.ok(!('session-id' in (calls[0]?.headers ?? {})), 'must not send session-id without sessionId')
  } finally {
    restore()
  }
})
