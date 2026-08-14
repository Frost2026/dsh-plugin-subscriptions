/**
 * Unit tests for the codex identity claims and the two subscription tools:
 * unsigned-JWT claim decoding, request building, response parsing, and the
 * error paths — all via injected fetch, no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { codexProfileClaims } from '../src/providers/codex.js'
import { TokenManager } from '../src/providers/common.js'
import type { FetchFn } from '../src/providers/common.js'
import type { CodexSession, GrokSession } from '../src/auth/store.js'
import {
  buildXSearchRequest,
  createXSearchTool,
  parseXSearchResponse,
} from '../src/tools/x-search.js'
import {
  buildImageGenerateBody,
  createImageGenerateTool,
  parseImageGenerateResponse,
} from '../src/tools/image-generate.js'

/** Mint an unsigned JWT carrying the given payload. */
function unsignedJwt(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`
}

/** Minimal execution context: the tools read only `signal`. */
function fakeExec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

function memoryTokens<S extends { accessToken: string; refreshToken: string; expiresAt: number }>(
  initial: S | undefined,
): TokenManager<S> {
  let stored = initial
  return new TokenManager<S>({
    displayName: 'Test',
    preemptMs: 0,
    load: () => Promise.resolve(stored),
    save: (session) => {
      stored = session
      return Promise.resolve()
    },
    remove: () => {
      stored = undefined
      return Promise.resolve()
    },
    refresh: session => Promise.resolve(session),
    isPermanent: () => false,
  })
}

function jsonFetch(payload: unknown, status = 200): { fetchFn: FetchFn; lastBody: () => unknown } {
  let body: unknown
  const fetchFn: FetchFn = ((_url: string, init?: RequestInit) => {
    body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    return Promise.resolve(new Response(JSON.stringify(payload), { status }))
  }) as FetchFn
  return { fetchFn, lastBody: () => body }
}

const codexSession: CodexSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  accountId: 'acct-1',
}
const grokSession: GrokSession = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  tokenEndpoint: 'https://auth.x.ai/token',
}

test('codexProfileClaims: top-level email and plan type', () => {
  const token = unsignedJwt({
    email: 'user@example.com',
    'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'acct-1' },
  })
  assert.deepEqual(codexProfileClaims(token), { emailAddress: 'user@example.com', planType: 'pro' })
})

test('codexProfileClaims: profile-namespaced email fallback and precedence', () => {
  const namespaced = unsignedJwt({
    'https://api.openai.com/profile': { email: 'profile@example.com' },
  })
  assert.deepEqual(codexProfileClaims(namespaced), { emailAddress: 'profile@example.com' })
  const both = unsignedJwt({
    email: 'top@example.com',
    'https://api.openai.com/profile': { email: 'profile@example.com' },
  })
  assert.equal(codexProfileClaims(both).emailAddress, 'top@example.com')
})

test('codexProfileClaims: missing or malformed tokens yield no claims', () => {
  assert.deepEqual(codexProfileClaims(undefined), {})
  assert.deepEqual(codexProfileClaims('not-a-jwt'), {})
  assert.deepEqual(codexProfileClaims(unsignedJwt({ sub: 'x' })), {})
})

test('buildXSearchRequest: validation and normalization', () => {
  assert.throws(() => buildXSearchRequest({ query: '  ' }), /non-empty/)
  assert.throws(
    () => buildXSearchRequest({ query: 'q', allowed_x_handles: ['a'], excluded_x_handles: ['b'] }),
    /cannot be used together/,
  )
  assert.throws(
    () => buildXSearchRequest({ query: 'q', allowed_x_handles: Array.from({ length: 11 }, (_, i) => `h${i}`) }),
    /at most 10/,
  )
  const request = buildXSearchRequest({
    query: ' news ',
    allowed_x_handles: ['@OpenAI', 'xai'],
    from_date: '2026-01-01',
    enable_video_understanding: true,
  })
  assert.equal(request.query, 'news')
  assert.deepEqual(request.tool, {
    type: 'x_search',
    allowed_x_handles: ['OpenAI', 'xai'],
    from_date: '2026-01-01',
    enable_video_understanding: true,
  })
})

test('parseXSearchResponse: answer, citations, inline annotations deduped', () => {
  const parsed = parseXSearchResponse({
    output: [{
      type: 'message',
      content: [{
        type: 'output_text',
        text: 'the answer',
        annotations: [
          { type: 'url_citation', url: 'https://x.com/a/status/1' },
          { type: 'url_citation', url: 'https://x.com/b/status/2' },
        ],
      }],
    }],
    citations: ['https://x.com/b/status/2', 'https://x.com/c/status/3'],
  })
  assert.equal(parsed.answer, 'the answer')
  assert.deepEqual(parsed.citations, ['https://x.com/b/status/2', 'https://x.com/c/status/3', 'https://x.com/a/status/1'])
})

test('x_search execute: success, error status, and logged-out', async () => {
  const { fetchFn, lastBody } = jsonFetch({ output_text: 'hello from X', citations: ['https://x.com/a/1'] })
  const tool = createXSearchTool({ tokens: memoryTokens(grokSession), fetchFn })
  const value = await tool.execute({ query: 'OpenAI' }, fakeExec()) as { answer: string; citations: string[] }
  assert.deepEqual(value, { answer: 'hello from X', citations: ['https://x.com/a/1'] })
  const body = lastBody() as { model: string; tools: { type: string }[]; store: boolean }
  assert.equal(body.model, 'grok-4')
  assert.deepEqual(body.tools, [{ type: 'x_search' }])
  assert.equal(body.store, false)

  const failing = createXSearchTool({ tokens: memoryTokens(grokSession), fetchFn: jsonFetch('rate limited', 429).fetchFn })
  await assert.rejects(
    () => failing.execute({ query: 'x' }, fakeExec()),
    (error: unknown) => error instanceof LlmError && error.code === 'RATE_LIMIT',
  )

  const loggedOut = createXSearchTool({ tokens: memoryTokens<GrokSession>(undefined), fetchFn })
  await assert.rejects(
    () => loggedOut.execute({ query: 'x' }, fakeExec()),
    (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
  )
})

test('x_search presentCall/presentResult shapes', async () => {
  const tool = createXSearchTool({ tokens: memoryTokens(grokSession), fetchFn: jsonFetch({}).fetchFn })
  assert.deepEqual(tool.presentCall?.({ query: 'OpenAI' }), {
    card: 'generic',
    title: 'x_search: OpenAI',
    kind: 'search',
  })
  const view = tool.presentResult?.({ query: 'OpenAI' }, {
    isError: false,
    content: [],
    meta: { answer: 'a', citations: ['https://x.com/a/1'] },
  })
  assert.deepEqual(view, {
    card: 'web',
    kind: 'search',
    sources: [{ url: 'https://x.com/a/1' }],
    answer: 'a',
    truncated: false,
  })
})

test('buildImageGenerateBody: validation and pass-through', () => {
  assert.throws(() => buildImageGenerateBody({ prompt: ' ' }), /non-empty/)
  assert.deepEqual(buildImageGenerateBody({ prompt: 'a square', size: '1024x1024', quality: 'low' }), {
    prompt: 'a square',
    model: 'gpt-image-2',
    size: '1024x1024',
    quality: 'low',
  })
  assert.deepEqual(buildImageGenerateBody({ prompt: 'p' }), { prompt: 'p', model: 'gpt-image-2' })
})

test('parseImageGenerateResponse: b64 decode, revised prompt, empty data', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const parsed = parseImageGenerateResponse({
    data: [{ b64_json: png.toString('base64'), revised_prompt: 'better prompt' }],
  })
  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0].data, png)
  assert.equal(parsed[0].revisedPrompt, 'better prompt')
  assert.throws(() => parseImageGenerateResponse({ data: [] }), /no image data/)
  assert.throws(() => parseImageGenerateResponse({}), /no image data/)
})

test('image_generate execute: writes files, error status, and logged-out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'subscriptions-images-'))
  const png = Buffer.from([1, 2, 3])
  const { fetchFn, lastBody } = jsonFetch({ created: 1, data: [{ b64_json: png.toString('base64') }] })
  const tool = createImageGenerateTool({ tokens: memoryTokens(codexSession), fetchFn, imagesDir: dir })
  const value = await tool.execute(
    { prompt: 'a tiny red square', size: '1024x1024', quality: 'low' },
    fakeExec(),
  ) as { paths: string[] }
  assert.equal(value.paths.length, 1)
  assert.ok(value.paths[0].startsWith(dir))
  assert.deepEqual(readFileSync(value.paths[0]), png)
  assert.equal(readdirSync(dir).length, 1)
  const body = lastBody() as Record<string, unknown>
  assert.deepEqual(body, { prompt: 'a tiny red square', model: 'gpt-image-2', size: '1024x1024', quality: 'low' })

  const failing = createImageGenerateTool({
    tokens: memoryTokens(codexSession),
    fetchFn: jsonFetch('bad request', 400).fetchFn,
    imagesDir: dir,
  })
  await assert.rejects(
    () => failing.execute({ prompt: 'x' }, fakeExec()),
    (error: unknown) => error instanceof LlmError && error.code === 'HTTP_400',
  )

  const loggedOut = createImageGenerateTool({
    tokens: memoryTokens<CodexSession>(undefined),
    fetchFn,
    imagesDir: dir,
  })
  await assert.rejects(
    () => loggedOut.execute({ prompt: 'x' }, fakeExec()),
    (error: unknown) => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
  )
})

test('image_generate presentCall', () => {
  const tool = createImageGenerateTool({ tokens: memoryTokens(codexSession), fetchFn: jsonFetch({}).fetchFn })
  assert.deepEqual(tool.presentCall?.({ prompt: 'a cat' }), {
    card: 'generic',
    title: 'image_generate: a cat',
  })
})
