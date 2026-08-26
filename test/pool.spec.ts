/**
 * The pool adapter: family aggregation across providers AND accounts, member
 * selection (priority failover and quota-aware urgency scheduling with sticky
 * hysteresis), stream failover semantics (switch before the first chunk,
 * never after), and capability intersection for pooled models. All members
 * are fake in-memory adapters.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PoolAdapter } from '../src/providers/pool.js'
import { buildFamilyPools, modelFamilyKey } from '../src/providers/pool-family.js'
import type { PoolDefinition, PoolMemberRef, ProviderPoolSource } from '../src/providers/pool-family.js'
import { memberKey, PoolHealthRegistry } from '../src/providers/pool-health.js'
import { PoolUsageTracker } from '../src/providers/pool-usage.js'
import type { ProviderUsage } from '../src/providers/common.js'
import type { ProviderId } from '../src/auth/store.js'
import type { AccountAwareAdapter } from '../src/providers/accounts.js'

/** Brand a string as a GenerateOptions sessionId (the loop-stamped session identity). */
const SessionId = (id: string): NonNullable<GenerateOptions['sessionId']> =>
  id as NonNullable<GenerateOptions['sessionId']>

const OPTIONS: GenerateOptions = { provider: 'codex', model: 'fam', messages: [] }

/** A scripted member adapter: serves chunks from `serve`, counts calls and the accounts used. */
class FakeAdapter extends LlmAdapter implements AccountAwareAdapter {
  calls = 0
  readonly accounts: string[] = []
  /** resolveModel calls that bypassed the own-model seam (must stay zero from the pool). */
  directResolves = 0

  constructor(
    private readonly serve: (options: GenerateOptions, account: string) => AsyncIterable<StreamChunk>,
    private readonly resolved: Partial<LlmResolvedModelInfo> = {},
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.directResolves += 1
    return this.resolveOwnModel(provider, model)
  }

  resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, ...this.resolved })
  }

  listOwnModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.streamCore(options, 'default')
  }

  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    return this.streamCore(options, account)
  }

  private async *streamCore(options: GenerateOptions, account: string): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.accounts.push(account)
    yield* this.serve(options, account)
  }
}

async function* serveOk(text = 'hi'): AsyncIterable<StreamChunk> {
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* serveFail(error: LlmError): AsyncIterable<StreamChunk> {
  throw error
}

async function* servePartial(error: LlmError): AsyncIterable<StreamChunk> {
  yield { type: 'text-delta', index: 0, text: 'partial' }
  throw error
}

async function* serveEmpty(): AsyncIterable<StreamChunk> {
  // A stream that ends without a single chunk.
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** A fresh family map per harness (the adapter filters pools in place). */
const freshFamily = (): Map<string, PoolDefinition> =>
  new Map([['fam', {
    members: [
      { provider: 'codex', account: 'a1', model: 'm' },
      { provider: 'claude', account: 'a1', model: 'm' },
    ],
  }]])

interface PoolHarness {
  pool: PoolAdapter
  health: PoolHealthRegistry
  usage: PoolUsageTracker
  warnings: string[]
}

function makePool(
  adapters: Partial<Record<ProviderId, FakeAdapter>>,
  options: {
    strategy?: 'priority' | 'quota_aware'
    switchMargin?: number
    usage?: Partial<Record<ProviderId, () => Promise<ProviderUsage>>>
    families?: Map<string, PoolDefinition>
    tiers?: Record<string, PoolMemberRef[]>
    defaultAccount?: string
  } = {},
): PoolHarness {
  const health = new PoolHealthRegistry()
  const usage = new PoolUsageTracker((provider, _account) => options.usage?.[provider])
  const warnings: string[] = []
  const pool = new PoolAdapter({
    adapters,
    health,
    usage,
    strategy: options.strategy ?? 'priority',
    switchMargin: options.switchMargin ?? 2,
    defaultAccount: () => Promise.resolve(options.defaultAccount ?? 'a1'),
    families: () => Promise.resolve(options.families ?? freshFamily()),
    tiers: options.tiers ?? {},
    onWarn: message => { warnings.push(message) },
  })
  return { pool, health, usage, warnings }
}

test('modelFamilyKey normalizes datestamps and version separators', () => {
  assert.equal(modelFamilyKey('claude-sonnet-4-5-20250929'), 'claude-sonnet-4.5')
  assert.equal(modelFamilyKey('claude-sonnet-4.5'), 'claude-sonnet-4.5')
  assert.equal(modelFamilyKey('Claude-Haiku-4-5-20251001'), 'claude-haiku-4.5')
  assert.equal(modelFamilyKey('gpt-5.4'), 'gpt-5.4')
})

/** A one-account pool source. */
function source(provider: ProviderId, ids: string[], accounts: readonly string[] = ['a1']): ProviderPoolSource {
  return { accounts, models: ids.map(id => ({ provider, id, name: id })) }
}

test('buildFamilyPools aggregates across providers, copilot last', () => {
  const pools = buildFamilyPools({
    copilot: source('copilot', ['gpt-5.4', 'claude-sonnet-4.5', 'gemini-2.5-pro']),
    codex: source('codex', ['gpt-5.4', 'gpt-5.4-mini']),
    claude: source('claude', ['claude-sonnet-4-5-20250929']),
    grok: source('grok', ['grok-4.6']),
  })
  assert.deepEqual(pools.get('gpt-5.4')?.members, [
    { provider: 'codex', account: 'a1', model: 'gpt-5.4' },
    { provider: 'copilot', account: 'a1', model: 'gpt-5.4' },
  ])
  assert.deepEqual(pools.get('claude-sonnet-4.5')?.members, [
    { provider: 'claude', account: 'a1', model: 'claude-sonnet-4-5-20250929' },
    { provider: 'copilot', account: 'a1', model: 'claude-sonnet-4.5' },
  ])
  // Single-account families (grok, gemini, gpt-5.4-mini) never become pools.
  assert.equal(pools.size, 2)
})

test('buildFamilyPools pools two accounts of one provider', () => {
  const pools = buildFamilyPools({
    claude: source('claude', ['claude-sonnet-4-5-20250929'], ['alice', 'bob']),
  })
  assert.deepEqual(pools.get('claude-sonnet-4.5')?.members, [
    { provider: 'claude', account: 'alice', model: 'claude-sonnet-4-5-20250929' },
    { provider: 'claude', account: 'bob', model: 'claude-sonnet-4-5-20250929' },
  ])
})

test('buildFamilyPools expands every account across providers', () => {
  const pools = buildFamilyPools({
    claude: source('claude', ['claude-sonnet-4.5'], ['alice', 'bob']),
    copilot: source('copilot', ['claude-sonnet-4.5']),
  })
  assert.deepEqual(pools.get('claude-sonnet-4.5')?.members, [
    { provider: 'claude', account: 'alice', model: 'claude-sonnet-4.5' },
    { provider: 'claude', account: 'bob', model: 'claude-sonnet-4.5' },
    { provider: 'copilot', account: 'a1', model: 'claude-sonnet-4.5' },
  ])
})

test('modelsForProvider lists each pool under the provider of its first member', async () => {
  const { pool } = makePool(
    { codex: new FakeAdapter(() => serveOk()), claude: new FakeAdapter(() => serveOk()) },
    { tiers: { smart: [{ provider: 'claude', account: 'a1', model: 'm' }] } },
  )
  const codexModels = await pool.modelsForProvider('codex')
  assert.deepEqual(codexModels.map(model => model.id), ['fam'])
  assert.equal(codexModels[0].provider, 'codex')
  // The tier pool's first member is claude, so it lists there, not here.
  const claudeModels = await pool.modelsForProvider('claude')
  assert.deepEqual(claudeModels.map(model => model.id), ['smart'])
  assert.deepEqual(await pool.modelsForProvider('grok'), [])
})

test('modelsForProvider shows the catalog name and description of the first member', async () => {
  const { pool } = makePool(
    { codex: new FakeAdapter(() => serveOk()), claude: new FakeAdapter(() => serveOk()) },
    {
      families: new Map([['gpt-5.4', {
        members: [
          { provider: 'codex', account: 'a1', model: 'gpt-5.4' },
          { provider: 'copilot', account: 'a1', model: 'gpt-5.4' },
        ],
        name: 'GPT-5.4',
        description: 'Latest frontier model.',
      }]]),
    },
  )
  const models = await pool.modelsForProvider('codex')
  assert.equal(models[0].name, 'GPT-5.4')
  assert.equal(models[0].description, 'Latest frontier model.')
})

test('owns recognizes only the pool models of the owning provider', async () => {
  const { pool } = makePool({ codex: new FakeAdapter(() => serveOk()), claude: new FakeAdapter(() => serveOk()) })
  assert.equal(await pool.owns('codex', 'fam'), true)
  assert.equal(await pool.owns('claude', 'fam'), false, 'fam is owned by codex')
  assert.equal(await pool.owns('codex', 'unknown'), false)
})

test('memberModelIds marks family members for absorption; tiers absorb nothing', async () => {
  const { pool } = makePool(
    { codex: new FakeAdapter(() => serveOk()), claude: new FakeAdapter(() => serveOk()) },
    { tiers: { smart: [{ provider: 'claude', account: 'a1', model: 'tier-model' }] } },
  )
  assert.deepEqual([...(await pool.memberModelIds('codex'))], ['m'])
  assert.deepEqual([...(await pool.memberModelIds('claude'))], ['m'])
  assert.deepEqual([...(await pool.memberModelIds('grok'))], [])
})

test('a tier pool overriding a family id wins with a single warning', async () => {
  const { pool, warnings } = makePool(
    { codex: new FakeAdapter(() => serveOk()), claude: new FakeAdapter(() => serveOk()) },
    { tiers: { fam: [{ provider: 'claude', account: 'a1', model: 'm' }] } },
  )
  const models = await pool.modelsForProvider('claude')
  assert.deepEqual(models.map(model => model.id), ['fam'])
  assert.equal(models[0].name, 'fam')
  assert.equal(models[0].description, undefined)
  // pools() runs per request; the configuration diagnostic must not repeat.
  await pool.modelsForProvider('claude')
  assert.equal(warnings.filter(message => message.includes('overrides')).length, 1)
})

test('priority: the first healthy member serves, through its account', async () => {
  const codex = new FakeAdapter(() => serveOk('codex'))
  const claude = new FakeAdapter(() => serveOk('claude'))
  const { pool } = makePool({ codex, claude })
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'codex')
  assert.equal(codex.calls, 1)
  assert.deepEqual(codex.accounts, ['a1'])
  assert.equal(claude.calls, 0)
})

test('priority: a configured member without an account uses the default account', async () => {
  const codex = new FakeAdapter(() => serveOk('codex'))
  const claude = new FakeAdapter(() => serveOk('claude'))
  const family = new Map<string, PoolDefinition>([
    ['fam', { members: [{ provider: 'codex', model: 'm' }, { provider: 'claude', account: 'bob', model: 'm' }] }],
  ])
  const { pool } = makePool({ codex, claude }, { families: family, defaultAccount: 'alice' })
  await collect(pool.stream(OPTIONS))
  assert.deepEqual(codex.accounts, ['alice'])
})

test('priority: a cooling member is skipped', async () => {
  const codex = new FakeAdapter(() => serveOk('codex'))
  const claude = new FakeAdapter(() => serveOk('claude'))
  const { pool, health } = makePool({ codex, claude })
  health.markUnavailable(memberKey('codex', 'a1', 'm'), 60_000, 'QUOTA')
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'claude')
  assert.equal(codex.calls, 0)
})

test('priority: a sticky session keeps its member after the leader recovers', async () => {
  const codex = new FakeAdapter(() => serveOk('codex'))
  const claude = new FakeAdapter(() => serveOk('claude'))
  const { pool, health } = makePool({ codex, claude })
  const options = { ...OPTIONS, sessionId: SessionId('s1') }
  health.markUnavailable(memberKey('codex', 'a1', 'm'), 60_000, 'QUOTA')
  await collect(pool.stream(options))
  assert.equal(claude.calls, 1)
  health.clear('codex')
  const chunks = await collect(pool.stream(options))
  assert.equal((chunks[0] as { text: string }).text, 'claude')
  assert.equal(codex.calls, 0)
})

/** Usage fetchers reading a mutable snapshot, for multi-phase tests. */
function usageFetchers(data: Partial<Record<ProviderId, ProviderUsage>>) {
  const fetchers: Partial<Record<ProviderId, () => Promise<ProviderUsage>>> = {}
  for (const provider of Object.keys(data) as ProviderId[]) {
    // Read through on every call: tests replace the snapshot between phases.
    fetchers[provider] = () => Promise.resolve(data[provider] as ProviderUsage)
  }
  return fetchers
}

/** A usage snapshot with one session window of `usedPercent`, resetting in `horizonMs`. */
function windowUsage(usedPercent: number, horizonMs: number): ProviderUsage {
  return {
    supported: true,
    windows: [{ kind: 'session', usedPercent, resetsAt: Date.now() + horizonMs }],
  }
}

test('quota_aware: the most urgent window (soon reset, plenty left) wins', async () => {
  const codex = new FakeAdapter(() => serveOk('codex'))
  const claude = new FakeAdapter(() => serveOk('claude'))
  const { pool } = makePool({ codex, claude }, {
    strategy: 'quota_aware',
    usage: usageFetchers({
      codex: windowUsage(50, 5 * 60 * 60_000),
      claude: windowUsage(10, 30 * 60_000),
    }),
  })
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'claude')
})

test('quota_aware: a window past the full mark gates its member out', async () => {
  const codex = new FakeAdapter(() => serveOk('codex'))
  const claude = new FakeAdapter(() => serveOk('claude'))
  const { pool } = makePool({ codex, claude }, {
    strategy: 'quota_aware',
    usage: usageFetchers({
      codex: windowUsage(50, 5 * 60 * 60_000),
      claude: windowUsage(96, 30 * 60_000),
    }),
  })
  await collect(pool.stream(OPTIONS))
  assert.equal(codex.calls, 1)
  assert.equal(claude.calls, 0)
})

test('quota_aware: a member without telemetry (copilot) sinks to the bottom', async () => {
  const codex = new FakeAdapter(() => serveOk('codex'))
  const copilot = new FakeAdapter(() => serveOk('copilot'))
  const family = new Map<string, PoolDefinition>([
    ['fam', {
      members: [
        { provider: 'codex', account: 'a1', model: 'm' },
        { provider: 'copilot', account: 'a1', model: 'm' },
      ],
    }],
  ])
  const { pool } = makePool({ codex, copilot }, {
    strategy: 'quota_aware',
    families: family,
    // Even 90% used with an hour to go beats "no data".
    usage: usageFetchers({ codex: windowUsage(90, 60 * 60_000) }),
  })
  await collect(pool.stream(OPTIONS))
  assert.equal(codex.calls, 1)
  assert.equal(copilot.calls, 0)
})

test('quota_aware: hysteresis holds the sticky member until the margin is beaten', async () => {
  const codex = new FakeAdapter(() => serveOk('codex'))
  const claude = new FakeAdapter(() => serveOk('claude'))
  const data: Partial<Record<ProviderId, ProviderUsage>> = {
    codex: windowUsage(0, 100 * 60_000),
    claude: windowUsage(0, 10 * 60_000),
  }
  const usage = usageFetchers(data)
  const { pool, usage: tracker } = makePool({ codex, claude }, { strategy: 'quota_aware', switchMargin: 2, usage })
  const options = { ...OPTIONS, sessionId: SessionId('s1') }

  // Phase 1: claude is far more urgent → serves and becomes sticky.
  await collect(pool.stream(options))
  assert.equal(claude.calls, 1)

  // Phase 2: codex gets 1.67x claude's urgency — inside the margin, sticky holds.
  data.claude = windowUsage(0, 100 * 60_000)
  data.codex = windowUsage(0, 60 * 60_000)
  tracker.invalidate('claude')
  tracker.invalidate('codex')
  const chunks = await collect(pool.stream(options))
  assert.equal((chunks[0] as { text: string }).text, 'claude')
  assert.equal(codex.calls, 0)

  // Phase 3: codex gets 3.3x claude's urgency — margin beaten, switch.
  data.codex = windowUsage(0, 30 * 60_000)
  tracker.invalidate('codex')
  const switched = await collect(pool.stream(options))
  assert.equal((switched[0] as { text: string }).text, 'codex')
})

test('stream: a pre-chunk quota failure cools the whole account and fails over', async () => {
  const codex = new FakeAdapter(() => serveFail(new LlmError('limited', 'RATE_LIMIT', { providerRetryAfterMs: 42_000 })))
  const claude = new FakeAdapter(() => serveOk('claude'))
  const usageCalls: ProviderId[] = []
  const { pool, health, usage, warnings } = makePool({ codex, claude }, {
    usage: {
      codex: () => {
        usageCalls.push('codex')
        return Promise.resolve(windowUsage(10, 60 * 60_000))
      },
    },
  })
  const member = { provider: 'codex' as const, account: 'a1', model: 'm' }
  // Prime the usage cache, then fail over: the quota failure must drop it.
  await usage.quotaFor(member)
  assert.equal(usageCalls.length, 1)
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'claude')
  assert.equal(codex.calls, 1)
  assert.equal(claude.calls, 1)
  assert.equal(health.isMemberAvailable('codex', 'a1', 'm'), false)
  // Codex quota is account-level: sibling models on the same account are
  // parked too, but another account of the provider is not.
  assert.equal(health.isMemberAvailable('codex', 'a1', 'other-model'), false)
  assert.equal(health.isMemberAvailable('codex', 'a2', 'm'), true)
  assert.equal(warnings.some(message => message.includes('trying the next member')), true)
  // The quota failure invalidated the cached snapshot: the next query re-polls.
  await usage.quotaFor(member)
  assert.equal(usageCalls.length, 2)
})

test('stream: a claude quota failure cools only the failing member', async () => {
  const claude = new FakeAdapter(() => serveFail(new LlmError('lane full', 'QUOTA')))
  const codex = new FakeAdapter(() => serveOk('codex'))
  const family = new Map<string, PoolDefinition>([
    ['fam', {
      members: [
        { provider: 'claude', account: 'a1', model: 'claude-opus-5' },
        { provider: 'codex', account: 'a1', model: 'm' },
      ],
    }],
  ])
  const { pool, health } = makePool({ claude, codex }, { families: family })
  await collect(pool.stream(OPTIONS))
  assert.equal(health.isMemberAvailable('claude', 'a1', 'claude-opus-5'), false)
  // Claude quota windows are model-scoped: the sibling lane stays available.
  assert.equal(health.isMemberAvailable('claude', 'a1', 'claude-sonnet-5'), true)
})

test('stream: a transient failure does not invalidate the usage snapshot', async () => {
  const codex = new FakeAdapter(() => serveFail(new LlmError('boom', 'SERVER')))
  const claude = new FakeAdapter(() => serveOk('claude'))
  const usageCalls: ProviderId[] = []
  const { pool, usage } = makePool({ codex, claude }, {
    usage: {
      codex: () => {
        usageCalls.push('codex')
        return Promise.resolve(windowUsage(10, 60 * 60_000))
      },
    },
  })
  const member = { provider: 'codex' as const, account: 'a1', model: 'm' }
  await usage.quotaFor(member)
  assert.equal(usageCalls.length, 1)
  await collect(pool.stream(OPTIONS))
  // A SERVER blip says nothing about quota: the cached snapshot survives.
  await usage.quotaFor(member)
  assert.equal(usageCalls.length, 1)
})

test('stream: a caller abandoning the stream closes the member stream', async () => {
  let closed = false
  async function* longServe(): AsyncIterable<StreamChunk> {
    try {
      yield { type: 'text-delta', index: 0, text: 'a' }
      yield { type: 'text-delta', index: 0, text: 'b' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      closed = true
    }
  }
  const codex = new FakeAdapter(() => longServe())
  const claude = new FakeAdapter(() => serveOk('claude'))
  const { pool } = makePool({ codex, claude })
  for await (const chunk of pool.stream(OPTIONS)) {
    void chunk
    break // The caller walks away after the first chunk.
  }
  assert.equal(closed, true)
})

test('stream: a post-chunk failure propagates without switching members', async () => {
  const codex = new FakeAdapter(() => servePartial(new LlmError('boom', 'SERVER')))
  const claude = new FakeAdapter(() => serveOk('claude'))
  const { pool } = makePool({ codex, claude })
  await assert.rejects(
    collect(pool.stream(OPTIONS)),
    (error: unknown) => error instanceof LlmError && error.code === 'SERVER',
  )
  assert.equal(claude.calls, 0)
})

test('stream: request-fault failures rethrow without trying other members', async () => {
  const codex = new FakeAdapter(() => serveFail(new LlmError('too long', 'CONTEXT_WINDOW_EXCEEDED')))
  const claude = new FakeAdapter(() => serveOk('claude'))
  const { pool, health } = makePool({ codex, claude })
  await assert.rejects(
    collect(pool.stream(OPTIONS)),
    (error: unknown) => error instanceof LlmError && error.code === 'CONTEXT_WINDOW_EXCEEDED',
  )
  assert.equal(claude.calls, 0)
  // No health record: the request was at fault, not the member.
  assert.equal(health.isAvailable(memberKey('codex', 'a1', 'm')), true)
})

test('stream: an empty first stream counts as a transient failure', async () => {
  const codex = new FakeAdapter(() => serveEmpty())
  const claude = new FakeAdapter(() => serveOk('claude'))
  const { pool } = makePool({ codex, claude })
  const chunks = await collect(pool.stream(OPTIONS))
  assert.equal((chunks[0] as { text: string }).text, 'claude')
})

test('stream: an exhausted pool throws RATE_LIMIT with the earliest recovery hint', async () => {
  const codex = new FakeAdapter(() => serveFail(new LlmError('a', 'RATE_LIMIT', { providerRetryAfterMs: 42_000 })))
  const claude = new FakeAdapter(() => serveFail(new LlmError('b', 'RATE_LIMIT', { providerRetryAfterMs: 90_000 })))
  const { pool } = makePool({ codex, claude })
  await assert.rejects(
    collect(pool.stream(OPTIONS)),
    (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'RATE_LIMIT')
      const retryAfter = error.failure.providerRetryAfterMs
      assert.ok(retryAfter !== undefined && retryAfter > 0 && retryAfter <= 42_000)
      return true
    },
  )
})

test('resolveModel intersects member capabilities conservatively', async () => {
  const codex = new FakeAdapter(() => serveOk(), {
    context: { contextWindow: 200_000 },
    defaultMaxTokens: 128_000,
    reasoning: {
      efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('medium'), name: 'Medium' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
      defaultEffort: ReasoningEffortId('high'),
    },
    inputModalities: ['text', 'image'],
  })
  const claude = new FakeAdapter(() => serveOk(), {
    context: { contextWindow: 100_000 },
    defaultMaxTokens: 64_000,
    reasoning: {
      efforts: [
        { id: ReasoningEffortId('medium'), name: 'Medium' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
      defaultEffort: ReasoningEffortId('medium'),
    },
    inputModalities: ['text'],
  })
  const { pool } = makePool({ codex, claude })
  const resolved = await pool.resolveModel('codex', 'fam')
  assert.equal(resolved.context?.contextWindow, 100_000)
  assert.equal(resolved.defaultMaxTokens, 64_000)
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['medium', 'high'])
  assert.equal(resolved.reasoning?.defaultEffort, 'high')
  assert.deepEqual(resolved.inputModalities, ['text'])
})

/** A member whose resolveModel always fails (misconfigured id, logged out). */
class FailingResolveAdapter extends FakeAdapter {
  constructor() {
    super(() => serveOk())
  }

  override resolveOwnModel(): Promise<LlmResolvedModelInfo> {
    return Promise.reject(new LlmError('logged out', 'AUTH'))
  }
}

test('resolveModel skips a member that fails to resolve and warns once', async () => {
  const codex = new FakeAdapter(() => serveOk(), { context: { contextWindow: 200_000 } })
  const claude = new FailingResolveAdapter()
  const { pool, warnings } = makePool({ codex, claude })
  const resolved = await pool.resolveModel('codex', 'fam')
  assert.equal(resolved.context?.contextWindow, 200_000)
  await pool.resolveModel('codex', 'fam')
  assert.equal(warnings.filter(message => message.includes('failed to resolve')).length, 1)
})

test('resolveModel throws NO_ADAPTER only when every member fails to resolve', async () => {
  const { pool } = makePool({ codex: new FailingResolveAdapter(), claude: new FailingResolveAdapter() })
  await assert.rejects(
    pool.resolveModel('codex', 'fam'),
    (error: unknown) => error instanceof LlmError && error.code === 'NO_ADAPTER',
  )
})

test('resolveModel reports unknown modalities when members share none', async () => {
  const codex = new FakeAdapter(() => serveOk(), { inputModalities: ['image'] })
  const claude = new FakeAdapter(() => serveOk(), { inputModalities: ['text'] })
  const { pool } = makePool({ codex, claude })
  const resolved = await pool.resolveModel('codex', 'fam')
  // An empty intersection must read as unknown, not "accepts nothing".
  assert.equal(resolved.inputModalities, undefined)
})

test('resolveModel: a pool id equal to the owner\'s own model id cannot recurse', async () => {
  // Regression: codex's catalog literally lists `gpt-5.4`, so the `gpt-5.4`
  // family pool is OWNED by codex while its member model id equals the pool
  // id. The pool must resolve members through resolveOwnModel — delegating
  // through resolveModel would bounce straight back into the pool forever
  // (the model picker hanging on "refreshing" was this).
  const codex = new FakeAdapter(() => serveOk(), { context: { contextWindow: 100_000 } })
  const copilot = new FakeAdapter(() => serveOk(), { context: { contextWindow: 200_000 } })
  const family = new Map<string, PoolDefinition>([
    ['m', {
      members: [
        { provider: 'codex', account: 'a1', model: 'm' },
        { provider: 'copilot', account: 'a1', model: 'm' },
      ],
    }],
  ])
  const { pool } = makePool({ codex, copilot }, { families: family })
  const resolved = await pool.resolveModel('codex', 'm')
  assert.equal(resolved.context?.contextWindow, 100_000)
  assert.equal(codex.directResolves, 0, 'member resolution went through resolveOwnModel')
  assert.equal(copilot.directResolves, 0)
})
