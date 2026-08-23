/**
 * Copilot provider unit tests beyond the catalog (models.spec.ts): the VS
 * Code version resolution behind the Editor-Version header, and the
 * GitHub-token → Copilot-token exchange. All fetches are injected; no network.
 *
 * Test order matters within this file: the version cache is module-level, so
 * the empty-cache fallback test runs first.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CallId, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  completeCopilotLogin,
  COPILOT_MODELS_URL,
  COPILOT_RESPONSES_URL,
  COPILOT_TOKEN_URL,
  CopilotAdapter,
  CopilotResponsesItemNormalizer,
  copilotChatRequestBody,
  copilotResponsesRequestBody,
  copilotRequestWire,
  copilotWireFor,
  exchangeCopilotToken,
  FALLBACK_VSCODE_VERSION,
  GITHUB_USER_URL,
  isCopilotPermanentRefreshError,
  latestVsCodeVersion,
  refreshCopilot,
  VSCODE_RELEASES_URL,
} from '../src/providers/copilot.js'
import { OAuthEndpointError, TokenManager, validateModels } from '../src/providers/common.js'
import type { DiscoveredModel, FetchFn, ModelEntry } from '../src/providers/common.js'
import type { CopilotSession } from '../src/auth/store.js'
import { streamResponses } from '../src/translate/responses.js'
import type { ResponsesStreamEvent } from '../src/translate/responses.js'

/** A fetch implementation routing canned responses by URL; records request headers. */
function fakeFetch(routes: Record<string, { payload: unknown; status?: number } | Error>): {
  fetchFn: FetchFn
  headers: (url: string) => Record<string, string>[]
} {
  const seen = new Map<string, Record<string, string>[]>()
  const fetchFn: FetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const route = routes[url]
    if (route === undefined) return Promise.reject(new Error(`unexpected fetch to ${url}`))
    const list = seen.get(url) ?? []
    list.push((init?.headers ?? {}) as Record<string, string>)
    seen.set(url, list)
    if (route instanceof Error) return Promise.reject(route)
    return Promise.resolve(new Response(JSON.stringify(route.payload), { status: route.status ?? 200 }))
  }) as FetchFn
  return { fetchFn, headers: url => seen.get(url) ?? [] }
}

test('latestVsCodeVersion falls back to the pinned version when the feed fails (empty cache)', async () => {
  const failing: FetchFn = () => Promise.reject(new Error('offline'))
  assert.equal(await latestVsCodeVersion(failing, true), FALLBACK_VSCODE_VERSION)
})

test('latestVsCodeVersion serves the latest stable from the feed, then the cache', async () => {
  const { fetchFn } = fakeFetch({ [VSCODE_RELEASES_URL]: { payload: ['3.1.4', '3.1.3'] } })
  assert.equal(await latestVsCodeVersion(fetchFn, true), '3.1.4')
  // A throwing fetch must not be consulted while the cache is fresh.
  const offline: FetchFn = () => Promise.reject(new Error('must not be called'))
  assert.equal(await latestVsCodeVersion(offline), '3.1.4')
})

test('latestVsCodeVersion serves the stale cache when a forced refresh fails', async () => {
  const offline: FetchFn = () => Promise.reject(new Error('offline'))
  assert.equal(await latestVsCodeVersion(offline, true), '3.1.4')
})

test('exchangeCopilotToken maps the wire response and presents the editor identity', async () => {
  const { fetchFn, headers } = fakeFetch({
    [VSCODE_RELEASES_URL]: { payload: ['1.2.3'] },
    [COPILOT_TOKEN_URL]: { payload: { token: 'copilot-token', expires_at: 2_000_000_000 } },
  })
  const pair = await exchangeCopilotToken('gh-token', fetchFn)
  assert.equal(pair.accessToken, 'copilot-token')
  assert.equal(pair.expiresAt, 2_000_000_000_000)
  const [sent] = headers(COPILOT_TOKEN_URL)
  assert.equal(sent.authorization, 'Bearer gh-token')
  // The exact version depends on the module-level cache (see the version
  // tests above); only the shape is asserted here.
  assert.match(sent['editor-version'], /^vscode\/\d+\.\d+\.\d+$/)
  assert.equal(sent['copilot-integration-id'], 'vscode-chat')
})

test('exchangeCopilotToken falls back to ~25 minutes when expires_at is absent', async () => {
  const { fetchFn } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { token: 'copilot-token' } },
  })
  const before = Date.now()
  const pair = await exchangeCopilotToken('gh-token', fetchFn)
  assert.ok(pair.expiresAt >= before + 24 * 60_000 && pair.expiresAt <= Date.now() + 25 * 60_000)
})

test('exchangeCopilotToken: a 401 is a permanent login loss', async () => {
  const { fetchFn } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { error: 'unauthorized' }, status: 401 },
  })
  await assert.rejects(
    exchangeCopilotToken('gh-token', fetchFn),
    (error: unknown) => error instanceof OAuthEndpointError && isCopilotPermanentRefreshError(error),
  )
})

test('completeCopilotLogin stores the GitHub token as the refresh token and reads the account', async () => {
  const { fetchFn } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { token: 'copilot-token', expires_at: 2_000_000_000 } },
    [GITHUB_USER_URL]: { payload: { login: 'octocat' } },
  })
  const session = await completeCopilotLogin('gh-token', fetchFn)
  assert.deepEqual(session, {
    accessToken: 'copilot-token',
    refreshToken: 'gh-token',
    expiresAt: 2_000_000_000_000,
    account: 'octocat',
  })
})

test('completeCopilotLogin tolerates a profile lookup failure', async () => {
  const { fetchFn } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { token: 'copilot-token', expires_at: 2_000_000_000 } },
    [GITHUB_USER_URL]: new Error('offline'),
  })
  const session = await completeCopilotLogin('gh-token', fetchFn)
  assert.equal(session.account, undefined)
  assert.equal(session.accessToken, 'copilot-token')
})

test('refreshCopilot re-exchanges and preserves the account', async () => {
  const stored: CopilotSession = {
    accessToken: 'old',
    refreshToken: 'gh-token',
    expiresAt: Date.now() - 1000,
    account: 'octocat',
  }
  const { fetchFn, headers } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { token: 'fresh-token', expires_at: 2_000_000_000 } },
  })
  const next = await refreshCopilot(stored, fetchFn)
  assert.deepEqual(next, {
    accessToken: 'fresh-token',
    refreshToken: 'gh-token',
    expiresAt: 2_000_000_000_000,
    account: 'octocat',
  })
  // The refresh exchanges with the GITHUB token, never the stale Copilot one.
  assert.equal(headers(COPILOT_TOKEN_URL)[0].authorization, 'Bearer gh-token')
})

/** Minimal generate options for the request body builders. */
const BODY_OPTIONS: GenerateOptions = {
  provider: 'copilot',
  model: 'gpt-5.6-sol',
  messages: [{
    id: MessageId('m-1'),
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }],
  maxTokens: 16_000,
}

test('copilotChatRequestBody sends max_completion_tokens, never max_tokens', () => {
  // gpt-5.4-and-later on Copilot reject the legacy `max_tokens` outright
  // (HTTP 400 "Unsupported parameter"); the rest of the catalog accepts the
  // new spelling.
  const body = copilotChatRequestBody(BODY_OPTIONS, [{ role: 'user', content: 'hi' }])
  assert.equal(body.max_completion_tokens, 16_000)
  assert.equal('max_tokens' in body, false)
  assert.equal('reasoning_effort' in body, false)
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
})

test('copilotChatRequestBody maps the selected effort to reasoning_effort', () => {
  const options = { ...BODY_OPTIONS, reasoningEffort: ReasoningEffortId('high') }
  const body = copilotChatRequestBody(options, [{ role: 'user', content: 'hi' }])
  assert.equal(body.reasoning_effort, 'high')
})

test('copilotResponsesRequestBody maps the selected effort to reasoning.effort', () => {
  const options = { ...BODY_OPTIONS, reasoningEffort: ReasoningEffortId('xhigh') }
  const body = copilotResponsesRequestBody(options, { input: [] })
  assert.deepEqual(body.reasoning, { effort: 'xhigh' })
})

test('copilotResponsesRequestBody maps the Responses wire shape', () => {
  const body = copilotResponsesRequestBody(BODY_OPTIONS, {
    instructions: 'be terse',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  })
  assert.deepEqual(body, {
    model: 'gpt-5.6-sol',
    instructions: 'be terse',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    max_output_tokens: 16_000,
    include: ['reasoning.encrypted_content'],
    stream: true,
  })
  // The encrypted-reasoning include is unconditional: a reasoning model needs
  // its blobs back on the next request, and non-reasoning models ignore it.
  assert.deepEqual(body.include, ['reasoning.encrypted_content'])
  // No system prompt → no instructions field; tools ride the Responses shape.
  const { maxTokens: omitted, ...bareOptions } = BODY_OPTIONS
  const bare = copilotResponsesRequestBody(
    { ...bareOptions, tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }] },
    { input: [] },
  )
  assert.equal('instructions' in bare, false)
  assert.equal('max_output_tokens' in bare, false)
  assert.deepEqual(bare.tools, [{ type: 'function', name: 'bash', description: 'run', parameters: { type: 'object' } }])
  assert.equal(bare.tool_choice, 'auto')
})

test('copilotWireFor defaults to chat completions unless the catalog says responses', () => {
  assert.equal(copilotWireFor(undefined), 'chat-completions')
  const chat: DiscoveredModel = { id: 'gpt-5-mini', name: 'GPT-5 mini', copilotWire: 'chat-completions' }
  assert.equal(copilotWireFor(chat), 'chat-completions')
  const responses: DiscoveredModel = { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', copilotWire: 'responses' }
  assert.equal(copilotWireFor(responses), 'responses')
  // An entry without the flag (static fallback path) stays on the chat wire.
  assert.equal(copilotWireFor({ id: 'gpt-4o', name: 'GPT-4o' }), 'chat-completions')
})

test('copilotRequestWire reroutes dual-protocol models to Responses for tools + effort', () => {
  // gpt-5.4 lists both endpoints: chat by default, but Copilot 400s there
  // once a request combines function tools with a reasoning effort
  // ("use /v1/responses or set reasoning_effort to 'none'").
  const dual: DiscoveredModel = {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    copilotWire: 'chat-completions',
    copilotResponses: true,
  }
  const tools = [{ name: 'bash', description: 'run', parameters: { type: 'object' } }]
  assert.equal(copilotRequestWire(dual, { tools, reasoningEffort: ReasoningEffortId('medium') }), 'responses')
  assert.equal(copilotRequestWire(dual, { tools, reasoningEffort: ReasoningEffortId('xhigh') }), 'responses')
  // 'none' is the one effort the chat wire accepts alongside tools.
  assert.equal(copilotRequestWire(dual, { tools, reasoningEffort: ReasoningEffortId('none') }), 'chat-completions')
  // Effort without tools, or tools without effort, keep the default wire.
  assert.equal(copilotRequestWire(dual, { reasoningEffort: ReasoningEffortId('medium') }), 'chat-completions')
  assert.equal(copilotRequestWire(dual, { tools }), 'chat-completions')
  assert.equal(copilotRequestWire(dual, {}), 'chat-completions')
  // A model listing no `/responses` (claude, kimi, …) never reroutes.
  const chatOnly: DiscoveredModel = { id: 'kimi-k3', name: 'Kimi K3', copilotWire: 'chat-completions' }
  assert.equal(
    copilotRequestWire(chatOnly, { tools, reasoningEffort: ReasoningEffortId('high') }),
    'chat-completions',
  )
  // Responses-only models and unknown entries keep their wire untouched.
  assert.equal(
    copilotRequestWire({ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', copilotWire: 'responses' }, {}),
    'responses',
  )
  assert.equal(copilotRequestWire(undefined, {}), 'chat-completions')
})

test('CopilotResponsesItemNormalizer folds per-event item ids into one stable key', () => {
  // Raw shape captured from api.githubcopilot.com/responses with gpt-5.6:
  // every event of one item carries a DIFFERENT opaque id. These captures
  // carry no output_index, so this test pins the last-added-key fallback and
  // must keep passing byte for byte.
  const normalizer = new CopilotResponsesItemNormalizer()
  const rewritten = [
    { type: 'response.output_item.added', item: { type: 'message', id: 'added-id' } },
    { type: 'response.output_text.delta', item_id: 'delta-id-1', delta: 'Hi' },
    { type: 'response.output_text.delta', item_id: 'delta-id-2', delta: ' there' },
    { type: 'response.output_item.done', item: { type: 'message', id: 'done-id', content: [{ type: 'output_text', text: 'Hi there' }] } },
  ].map(event => normalizer.push(event as ResponsesStreamEvent))
  assert.equal(rewritten[0]?.item?.id, 'copilot-item-1')
  assert.equal(rewritten[1]?.item_id, 'copilot-item-1')
  assert.equal(rewritten[2]?.item_id, 'copilot-item-1')
  assert.equal(rewritten[3]?.item?.id, 'copilot-item-1')
  // The next item gets the next ordinal.
  const next = normalizer.push({ type: 'response.output_item.added', item: { type: 'function_call', id: 'x', call_id: 'call-1', name: 'bash' } })
  assert.equal(next.item?.id, 'copilot-item-2')
})

test('normalized Copilot Responses events assemble text and whole-done tool arguments', async () => {
  // End-to-end through the shared translator with the normalizer: text
  // fragments join into one block, and a function call whose argument deltas
  // are empty (the gateway delivers the arguments whole on done) closes with
  // the full payload.
  const normalizer = new CopilotResponsesItemNormalizer()
  const events: ResponsesStreamEvent[] = [
    { type: 'response.output_item.added', item: { type: 'message', id: 'a' } },
    { type: 'response.output_text.delta', item_id: 'd1', delta: 'Hi' },
    { type: 'response.output_text.delta', item_id: 'd2', delta: '!' },
    { type: 'response.output_item.done', item: { type: 'message', id: 'b', content: [{ type: 'output_text', text: 'Hi!' }] } },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'c', call_id: 'call-9', name: 'bash' } },
    { type: 'response.function_call_arguments.delta', item_id: 'd3', delta: '' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'e', call_id: 'call-9', name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 3 } } },
  ]
  const frames = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames))
      controller.close()
    },
  })
  const chunks: { type: string; block?: { type: string; name?: string; text?: string; arguments?: string } }[] = []
  for await (const chunk of streamResponses(stream, undefined, event => normalizer.push(event))) {
    chunks.push(chunk as { type: string; block?: { type: string; name?: string; text?: string; arguments?: string } })
  }
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0], { type: 'text', text: 'Hi!' })
  assert.equal(blocks[1]?.type, 'tool-call')
  assert.equal(blocks[1]?.name, 'bash')
  assert.equal(blocks[1]?.arguments, '{"cmd":"ls"}')
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.equal(finish?.type, 'finish')
})

test('CopilotResponsesItemNormalizer keys interleaved items by output_index, not arrival order', () => {
  // Two items interleaved on the wire (parallel tool calls): every event
  // carries a fresh gateway id, so output_index is the only correlator.
  const normalizer = new CopilotResponsesItemNormalizer()
  const itemKey = (event: ResponsesStreamEvent): string | undefined => {
    const rewritten = normalizer.push(event)
    return rewritten.item?.id ?? rewritten.item_id
  }
  assert.equal(
    itemKey({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'A1', call_id: 'call-A', name: 'bash' } }),
    'copilot-item-0',
  )
  assert.equal(
    itemKey({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'B1', call_id: 'call-B', name: 'grep' } }),
    'copilot-item-1',
  )
  // Interleaved deltas and dones land on their own item's key.
  assert.equal(
    itemKey({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'A2', delta: '' }),
    'copilot-item-0',
  )
  assert.equal(
    itemKey({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'B2', delta: '' }),
    'copilot-item-1',
  )
  assert.equal(
    itemKey({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'A3' } }),
    'copilot-item-0',
  )
  assert.equal(
    itemKey({ type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'B3' } }),
    'copilot-item-1',
  )
  // A no-index event falls back to the LAST added item's key.
  assert.equal(itemKey({ type: 'response.output_text.delta', item_id: 'late', delta: 'x' }), 'copilot-item-1')
})

/** Encode Responses events as one SSE payload string. */
function sseBody(events: ResponsesStreamEvent[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
}

/** Encode Responses events as the SSE byte stream the adapter consumes. */
function sseStream(events: ResponsesStreamEvent[]): ReadableStream<Uint8Array> {
  const frames = sseBody(events)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames))
      controller.close()
    },
  })
}

test('normalized interleaved Copilot tool calls assemble into separate blocks', async () => {
  // End-to-end through the shared translator: two function calls interleaved
  // per-event (fresh ids everywhere, output_index the only correlator), each
  // call's arguments delivered whole only on its done event.
  const normalizer = new CopilotResponsesItemNormalizer()
  const events: ResponsesStreamEvent[] = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'a1', call_id: 'call-A', name: 'bash' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'b1', call_id: 'call-B', name: 'grep' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'a2', delta: '' },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'b2', delta: '' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'a3', call_id: 'call-A', name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'b3', call_id: 'call-B', name: 'grep', arguments: '{"q":"x"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 3 } } },
  ]
  const chunks: { type: string; block?: { type: string; id?: string; name?: string; arguments?: string } }[] = []
  for await (const chunk of streamResponses(sseStream(events), undefined, event => normalizer.push(event))) {
    chunks.push(chunk as { type: string; block?: { type: string; id?: string; name?: string; arguments?: string } })
  }
  // Each call closes as its own tool-call block with its own arguments.
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.deepEqual(blocks, [
    { type: 'tool-call', id: 'call-A', name: 'bash', arguments: '{"cmd":"ls"}' },
    { type: 'tool-call', id: 'call-B', name: 'grep', arguments: '{"q":"x"}' },
  ])
  assert.deepEqual(chunks.find(chunk => chunk.type === 'finish'), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('validateModels passes a configured wire through and rejects unknown values', () => {
  assert.deepEqual(
    validateModels([{ id: 'gpt-5.6-sol', wire: 'responses' }], 'test: copilot'),
    [{ id: 'gpt-5.6-sol', wire: 'responses' }],
  )
  const bogus: unknown = { id: 'm', wire: 'bogus' }
  assert.throws(
    () => validateModels([bogus as ModelEntry], 'test: copilot'),
    /test: copilot: catalog model "m" wire must be "chat-completions" or "responses"/,
  )
})

const copilotSession: CopilotSession = {
  accessToken: 'copilot-at',
  refreshToken: 'gh-token',
  expiresAt: Date.now() + 3_600_000,
}

/** A TokenManager over an in-memory session; refresh never fires here. */
function memoryTokens(initial: CopilotSession): TokenManager<CopilotSession> {
  let stored: CopilotSession | undefined = initial
  return new TokenManager<CopilotSession>({
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

/**
 * Record-and-replay stub for the AMBIENT generation fetch: the adapter sends
 * provider traffic through global fetch (the repo-wide adapter pattern; only
 * discovery takes an injected fetchFn), so adapter-level stream tests patch
 * the global and restore it in a finally. node:test runs one file's tests
 * sequentially, so the patch window is race-free. Each queued SSE payload
 * answers one request in call order; request url + parsed body are recorded.
 */
function recordingSseFetch(queuedResponses: string[]): {
  calls: { url: string; body: Record<string, unknown> }[]
  restore(): void
} {
  const original = globalThis.fetch
  const calls: { url: string; body: Record<string, unknown> }[] = []
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === VSCODE_RELEASES_URL) {
      return Promise.resolve(new Response(JSON.stringify(['1.9.9']), { status: 200 }))
    }
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const payload = queuedResponses.shift()
    if (payload === undefined) return Promise.reject(new Error(`unexpected fetch to ${url}`))
    return Promise.resolve(new Response(payload))
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** A minimal completed Responses SSE payload (one text item, then finish). */
const COMPLETED_SSE = sseBody([
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm2', content: [{ type: 'output_text', text: 'ok' }] } },
  { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
])

/** Minimal generate options for adapter.stream() calls. */
const STREAM_OPTIONS: GenerateOptions = {
  provider: 'copilot',
  model: 'gpt-5.6-sol',
  messages: [{
    id: MessageId('m-stream'),
    role: 'user',
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }],
  maxTokens: 1_000,
}

test('a configured wire routes the request even without discovery', async () => {
  // Review finding on #26: a manually configured responses-only model with
  // discovery:false left discovered() undefined, so the request silently
  // defaulted to /chat/completions and the gateway rejected it.
  const { calls, restore } = recordingSseFetch([COMPLETED_SSE])
  try {
    const adapter = new CopilotAdapter({
      models: [{ id: 'gpt-5.6-sol', wire: 'responses' }],
      streamIdleTimeoutMs: 1000,
      tokens: memoryTokens(copilotSession),
      discovery: false,
    })
    const chunks: { type: string }[] = []
    for await (const chunk of adapter.stream(STREAM_OPTIONS)) {
      chunks.push(chunk as { type: string })
    }
    assert.equal(chunks.at(-1)?.type, 'finish')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, COPILOT_RESPONSES_URL)
    assert.equal(calls[0]?.body.model, 'gpt-5.6-sol')
  } finally {
    restore()
  }
})

test('a configured wire outranks a discovered chat-wire catalog entry', async () => {
  // Discovery (were it consulted) reports gpt-4.1 as /chat/completions, but
  // the config pins it to responses: the explicit config wins, and the
  // discovery fetch is never needed for the routing decision.
  const discovery: FetchFn = ((input: RequestInfo | URL) => {
    const url = String(input)
    if (url === VSCODE_RELEASES_URL) return Promise.resolve(new Response(JSON.stringify(['1.9.9'])))
    if (url === COPILOT_MODELS_URL) {
      return Promise.resolve(new Response(JSON.stringify({
        data: [{
          id: 'gpt-4.1',
          name: 'GPT-4.1',
          model_picker_enabled: true,
          policy: { state: 'enabled' },
          supported_endpoints: ['/chat/completions'],
        }],
      })))
    }
    return Promise.reject(new Error(`unexpected discovery fetch to ${url}`))
  }) as FetchFn
  const { calls, restore } = recordingSseFetch([COMPLETED_SSE])
  try {
    const adapter = new CopilotAdapter({
      models: [{ id: 'gpt-4.1', wire: 'responses' }],
      streamIdleTimeoutMs: 1000,
      tokens: memoryTokens(copilotSession),
      discovery: true,
      fetchFn: discovery,
    })
    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, model: 'gpt-4.1' })) {
      void chunk
    }
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, COPILOT_RESPONSES_URL)
  } finally {
    restore()
  }
})

test('CopilotResponsesItemNormalizer captures call ids and encrypted reasoning on completion', () => {
  const captures: { callIds: string[]; encrypted: string[] }[] = []
  const normalizer = new CopilotResponsesItemNormalizer((callIds, encrypted) => {
    captures.push({ callIds: [...callIds], encrypted: [...encrypted] })
  })
  normalizer.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'r1' } })
  normalizer.push({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'r2', encrypted_content: 'ENC1' } })
  normalizer.push({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'f1', call_id: 'call-7', name: 'bash' } })
  normalizer.push({ type: 'response.completed', response: {} })
  assert.deepEqual(captures, [{ callIds: ['call-7'], encrypted: ['ENC1'] }])
  // Cleared after the fire: a second completed event in the same stream must
  // not re-report the first response's pair.
  normalizer.push({ type: 'response.completed', response: {} })
  assert.equal(captures.length, 1)
})

test('CopilotResponsesItemNormalizer does not capture without both sides of the pair', () => {
  const captures: unknown[][] = []
  const normalizer = new CopilotResponsesItemNormalizer((callIds, encrypted) => {
    captures.push([callIds, encrypted])
  })
  // A function call with no encrypted reasoning in its response.
  normalizer.push({ type: 'response.output_item.added', item: { type: 'function_call', id: 'f1', call_id: 'call-7' } })
  normalizer.push({ type: 'response.completed', response: {} })
  // Encrypted reasoning with no function call in its response.
  normalizer.push({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'r1', encrypted_content: 'ENC1' } })
  normalizer.push({ type: 'response.completed', response: {} })
  // Malformed shapes (empty call_id, empty encrypted_content) never collect.
  normalizer.push({ type: 'response.output_item.added', item: { type: 'function_call', id: 'f2', call_id: '' } })
  normalizer.push({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'r2', encrypted_content: '' } })
  normalizer.push({ type: 'response.completed', response: {} })
  assert.equal(captures.length, 0)
})

/**
 * SSE payload for the adapter-level capture tests: the model reasons (the
 * reasoning done carries the encrypted blob when `encrypted` is given) and
 * issues one tool call whose arguments arrive whole on done.
 */
function reasoningToolCallSse(encrypted: string | undefined): string {
  return sseBody([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'r1' } },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: encrypted === undefined
        ? { type: 'reasoning', id: 'r2' }
        : { type: 'reasoning', id: 'r2', encrypted_content: encrypted },
    },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'f1', call_id: 'call_A', name: 'bash' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'f2', delta: '' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'f3', call_id: 'call_A', name: 'bash', arguments: '{"cmd":"ls"}' } },
    { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 4 } } },
  ])
}

/** The conversation handed back for the second request after call_A ran. */
function toolRoundTripHistory(): GenerateOptions['messages'] {
  return [
    {
      id: MessageId('m-a'),
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'tool-call', id: CallId('call_A'), name: 'bash', arguments: '{"cmd":"ls"}' },
      ],
      source: { kind: 'model', provider: 'copilot', model: 'gpt-5.6-sol' },
    },
    {
      id: MessageId('m-b'),
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: CallId('call_A'), content: [{ type: 'text', text: 'file-a' }] }],
      source: { kind: 'tool', callId: CallId('call_A') },
    },
  ]
}

/** A wire-forced responses adapter with no discovery, over the global fetch stub. */
function responsesAdapter(): CopilotAdapter {
  return new CopilotAdapter({
    models: [{ id: 'gpt-5.6-sol', wire: 'responses' }],
    streamIdleTimeoutMs: 1000,
    tokens: memoryTokens(copilotSession),
    discovery: false,
  })
}

test('adapter replays captured encrypted reasoning immediately before its tool call', async () => {
  // Two phases through ONE adapter: the first response reasons and calls
  // call_A; the second request (tool result in hand) must replay the captured
  // encrypted reasoning directly ahead of the replayed function_call.
  const { calls, restore } = recordingSseFetch([reasoningToolCallSse('ENC1'), COMPLETED_SSE])
  try {
    const adapter = responsesAdapter()
    const first: { type: string; block?: { type?: string; id?: string } }[] = []
    for await (const chunk of adapter.stream(STREAM_OPTIONS)) {
      first.push(chunk as { type: string; block?: { type?: string; id?: string } })
    }
    const toolBlocks = first.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
    assert.equal(toolBlocks.length, 1)
    assert.equal(toolBlocks[0]?.block?.id, 'call_A')

    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, messages: toolRoundTripHistory() })) {
      void chunk
    }
    const input = calls[1]?.body.input as Record<string, unknown>[]
    const reasoningIndex = input.findIndex(item => item.type === 'reasoning')
    assert.ok(reasoningIndex >= 0, 'the encrypted reasoning item is replayed')
    const callIndex = input.findIndex(item => item.type === 'function_call' && item.call_id === 'call_A')
    assert.equal(callIndex, reasoningIndex + 1)
    assert.deepEqual(input[reasoningIndex], { type: 'reasoning', encrypted_content: 'ENC1' })
  } finally {
    restore()
  }
})

test('a response without encrypted reasoning captures nothing to replay', async () => {
  // Degradation: the reasoning item arrives without encrypted_content (model
  // not reasoning, or the gateway strips the blob) — the follow-up request's
  // input carries no reasoning items, exactly the pre-capture behavior.
  const { calls, restore } = recordingSseFetch([reasoningToolCallSse(undefined), COMPLETED_SSE])
  try {
    const adapter = responsesAdapter()
    for await (const chunk of adapter.stream(STREAM_OPTIONS)) {
      void chunk
    }
    for await (const chunk of adapter.stream({ ...STREAM_OPTIONS, messages: toolRoundTripHistory() })) {
      void chunk
    }
    const input = calls[1]?.body.input as Record<string, unknown>[]
    assert.equal(input.some(item => item.type === 'reasoning'), false)
  } finally {
    restore()
  }
})
