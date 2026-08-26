/**
 * The pool adapter: aggregates the subscription adapters into logical models
 * — automatically-discovered family pools (the same model reachable through
 * several accounts) and user-configured tier pools (heterogeneous fallbacks).
 * Members are account-granular: every logged-in account of a provider is its
 * own member with its own cooldowns and quota tracking. Member selection is
 * sticky per session (so prompt caches survive) and optionally quota-aware
 * (so about-to-reset subscription windows get spent instead of wasted);
 * failures fail over to the next member as long as no stream chunk has been
 * emitted.
 *
 * The pool owns no provider route of its own: each pooled model is listed
 * under the provider group of its first member (the `pool/<id>` model id
 * keeps it from colliding with the provider's direct model of the same
 * family), and that provider's adapter delegates the request back here.
 */

import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../auth/store.js'
import type { AccountAwareAdapter } from './accounts.js'
import type { ConcretePoolMember, PoolDefinition, PoolMemberRef } from './pool-family.js'
import { accountKey, classifyPoolFailure, memberKey, PoolHealthRegistry } from './pool-health.js'
import type { MemberQuota, PoolUsageTracker } from './pool-usage.js'

/** Member-selection strategy: plain priority failover or quota-aware scheduling. */
export type PoolStrategy = 'priority' | 'quota_aware'

export interface PoolAdapterOptions {
  /** The live subscription adapters, by provider route. */
  adapters: Partial<Record<ProviderId, AccountAwareAdapter>>
  health: PoolHealthRegistry
  usage: PoolUsageTracker
  strategy: PoolStrategy
  /** A challenger must out-urgency the sticky member by this factor to take over. */
  switchMargin: number
  /** The default account of one provider (for config members omitting `account`). */
  defaultAccount: (provider: ProviderId) => Promise<string | undefined>
  /** Family pools (auto-aggregated plus config overrides), resolved lazily. */
  families: () => Promise<Map<string, PoolDefinition>>
  /** User-configured heterogeneous pools, by pool id. */
  tiers: Record<string, PoolMemberRef[]>
  onWarn: (message: string) => void
}

/** Bound on sticky-session memory; oldest entries evict past it. */
const STICKY_SESSION_LIMIT = 1000

/** Display form of one member (account shown when pinned). */
function memberLabel(member: PoolMemberRef): string {
  return member.account === undefined
    ? `${member.provider}/${member.model}`
    : `${member.provider}/${member.account}/${member.model}`
}

/** How long a pools snapshot is trusted (auth changes re-announce within this window). */
const POOLS_CACHE_TTL_MS = 5_000

export class PoolAdapter extends LlmAdapter {
  /** sessionId|poolId → member key of the last member that served a chunk. */
  private readonly sticky = new Map<string, string>()
  /** Messages already warned about — configuration diagnostics repeat every request otherwise. */
  private readonly warned = new Set<string>()
  /**
   * Short-lived pools snapshot. `owns()` runs on every resolveModel — the
   * model picker issues one per entry — and pool assembly touches every
   * provider's catalog and account store, so recompute at most this often.
   */
  private poolsCache: { at: number; pools: Map<string, PoolDefinition> } | undefined
  private poolsInflight: Promise<Map<string, PoolDefinition>> | undefined

  constructor(private readonly options: PoolAdapterOptions) {
    super()
  }

  /** Warn once per distinct message (pools() runs on every request). */
  private warnOnce(message: string): void {
    if (this.warned.has(message)) return
    this.warned.add(message)
    this.options.onWarn(message)
  }

  /** Drop members whose adapter is not registered (copy — caller state is shared). */
  private usable(pools: Map<string, PoolDefinition>): Map<string, PoolDefinition> {
    const result = new Map<string, PoolDefinition>(pools)
    for (const [id, definition] of [...result]) {
      const kept = definition.members.filter(member => this.options.adapters[member.provider] !== undefined)
      if (kept.length === 0) result.delete(id)
      else if (kept.length < definition.members.length) result.set(id, { ...definition, members: kept })
    }
    return result
  }

  /** Family pools (auto-aggregated plus config overrides) with usable members. */
  private async familyPools(): Promise<Map<string, PoolDefinition>> {
    return this.usable(new Map<string, PoolDefinition>(await this.options.families()))
  }

  /** All pools (families merged with tiers) with usable members. */
  private async pools(): Promise<Map<string, PoolDefinition>> {
    const cached = this.poolsCache
    if (cached !== undefined && Date.now() - cached.at < POOLS_CACHE_TTL_MS) return cached.pools
    this.poolsInflight ??= this.assemblePools()
      .then((pools) => {
        this.poolsCache = { at: Date.now(), pools }
        return pools
      })
      .finally(() => {
        this.poolsInflight = undefined
      })
    return this.poolsInflight
  }

  /** Recompute the pools snapshot (families merged with tiers). */
  private async assemblePools(): Promise<Map<string, PoolDefinition>> {
    const pools = await this.familyPools()
    for (const [id, members] of Object.entries(this.options.tiers)) {
      if (pools.has(id)) this.warnOnce(`tier pool "${id}" overrides the family pool of the same id`)
      pools.set(id, { members })
    }
    return this.usable(pools)
  }

  /** The provider group a pool lists under: its first usable member's provider. */
  private static ownerOf(definition: PoolDefinition): ProviderId {
    return definition.members[0].provider
  }

  /**
   * The pooled models one provider group lists (its own pools only), called
   * by the member adapters' `listModels`. The pool takes the family/tier id
   * itself — member adapters suppress the members' own catalog entries, so
   * the picker shows one entry per family, not one per route. Display
   * metadata comes from the first member's catalog entry (auto families), so
   * a pooled model reads exactly like the direct entry it absorbed.
   */
  async modelsForProvider(provider: ProviderId): Promise<LlmModelInfo[]> {
    const pools = await this.pools()
    const models: LlmModelInfo[] = []
    for (const [id, definition] of pools) {
      if (PoolAdapter.ownerOf(definition) !== provider) continue
      models.push({
        provider,
        id,
        name: definition.name ?? id,
        ...definition.description === undefined ? {} : { description: definition.description },
      })
    }
    return models
  }

  /**
   * Model ids of one provider absorbed into family pools — the member
   * adapters drop these from their own catalogs so a family shows once
   * (tier pools absorb nothing: their members are distinct models).
   */
  async memberModelIds(provider: ProviderId): Promise<ReadonlySet<string>> {
    const ids = new Set<string>()
    for (const definition of (await this.familyPools()).values()) {
      for (const member of definition.members) {
        if (member.provider === provider) ids.add(member.model)
      }
    }
    return ids
  }

  /**
   * Whether `model` on `provider`'s route is a pooled model (owned by this
   * provider's group). Member adapters delegate those calls here.
   */
  async owns(provider: ProviderId, model: string): Promise<boolean> {
    const definition = (await this.pools()).get(model)
    return definition !== undefined && PoolAdapter.ownerOf(definition) === provider
  }

  /**
   * Resolve every member's account (config members may omit it to mean "the
   * default account") and drop members with no resolvable login. Duplicates
   * collapse — an explicitly pinned account and the default may coincide.
   */
  private async concrete(members: readonly PoolMemberRef[]): Promise<ConcretePoolMember[]> {
    const seen = new Set<string>()
    const resolved: ConcretePoolMember[] = []
    for (const member of members) {
      const account = member.account ?? await this.options.defaultAccount(member.provider)
      if (account === undefined) continue
      const key = memberKey(member.provider, account, member.model)
      if (seen.has(key)) continue
      seen.add(key)
      resolved.push({ provider: member.provider, account, model: member.model })
    }
    return resolved
  }

  /**
   * Resolve a pool model to the conservative INTERSECTION of its members'
   * capabilities: the smallest context window and output cap, the reasoning
   * efforts every member supports, and the modalities all of them accept —
   * so a request valid for the pool stays valid after a failover. Capability
   * metadata is provider-level, so each provider resolves once regardless of
   * how many accounts it pools.
   */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const pool = (await this.pools()).get(model)
    if (pool === undefined) throw new LlmError(`unknown pool model "${model}"`, 'NO_ADAPTER')
    const resolved: LlmResolvedModelInfo[] = []
    let lastFailure: unknown
    const seenProviders = new Set<ProviderId>()
    for (const member of pool.members) {
      if (seenProviders.has(member.provider)) continue
      seenProviders.add(member.provider)
      const adapter = this.options.adapters[member.provider]
      if (adapter === undefined) continue
      // Tolerate per-member failures (a misconfigured tier member, a
      // logged-out provider throwing AUTH): the pool serves as long as ONE
      // member resolves, mirroring stream()'s failover semantics.
      try {
        resolved.push(await adapter.resolveOwnModel(member.provider, member.model))
      } catch (error: unknown) {
        lastFailure = error
        this.warnOnce(
          `pool "${model}": member ${memberLabel(member)} failed to resolve`
          + ` (${error instanceof Error ? error.message : String(error)}); excluding it`,
        )
      }
    }
    if (resolved.length === 0) {
      throw new LlmError(`pool "${model}" has no usable member`, 'NO_ADAPTER', {
        ...lastFailure === undefined ? {} : { cause: lastFailure },
      })
    }
    const contextWindows = resolved.map(info => info.context?.contextWindow).filter(isNumber)
    const maxTokens = resolved.map(info => info.defaultMaxTokens).filter(isNumber)
    const reasoning = intersectReasoning(resolved)
    const modalities = intersectModalities(resolved)
    return {
      provider,
      id: model,
      name: model,
      ...contextWindows.length > 0 ? { context: { contextWindow: Math.min(...contextWindows) } } : {},
      ...maxTokens.length > 0 ? { defaultMaxTokens: Math.min(...maxTokens) } : {},
      ...reasoning === undefined ? {} : { reasoning },
      ...modalities === undefined ? {} : { inputModalities: modalities },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const pool = (await this.pools()).get(options.model)
    if (pool === undefined) throw new LlmError(`unknown pool model "${options.model}"`, 'NO_ADAPTER')
    const members = await this.concrete(pool.members)
    const candidates = await this.select(options.model, members, options.sessionId)
    if (candidates.length === 0) throw this.exhausted(options.model, members)
    let lastError: unknown
    for (const member of candidates) {
      const adapter = this.options.adapters[member.provider]
      if (adapter === undefined) continue
      const iterator = adapter.streamAccount(
        { ...options, provider: member.provider, model: member.model },
        member.account,
      )[Symbol.asyncIterator]()
      let first: IteratorResult<StreamChunk>
      try {
        first = await iterator.next()
        if (first.done === true) {
          throw new LlmError(`${memberLabel(member)} returned an empty stream`, EMPTY_RESPONSE_CODE)
        }
      } catch (error: unknown) {
        const classification = classifyPoolFailure(error, member.provider)
        if (classification.action === 'throw') throw error
        if ('cooldownMs' in classification) {
          this.options.health.markUnavailable(
            classification.scope === 'account'
              ? accountKey(member.provider, member.account)
              : memberKey(member.provider, member.account, member.model),
            classification.cooldownMs,
            classification.reason,
          )
          // A quota failure invalidates the cached usage snapshot so the NEXT
          // selection re-polls instead of trusting minutes-old percentages.
          // Transient/auth failures say nothing about quota — keep the cache.
          if (classification.reason === QUOTA_EXCEEDED_CODE || classification.reason === 'RATE_LIMIT') {
            this.options.usage.invalidate(member.provider, member.account)
          }
        }
        this.options.onWarn(
          `pool "${options.model}": ${memberLabel(member)} failed before any output`
          + ` (${error instanceof Error ? error.message : String(error)}); trying the next member`,
        )
        lastError = error
        continue
      }
      this.remember(options.model, options.sessionId, member)
      // Past the first chunk there is no clean attempt boundary: whatever
      // the member does next (including failing) reaches the caller as-is.
      // The finally closes the member stream when the CALLER walks away
      // early (break / .return()) — manual iteration does not propagate
      // closure the way `yield*` would, and a half-consumed member stream
      // must not linger holding its connection.
      try {
        yield first.value
        for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
          yield next.value
        }
      } finally {
        try {
          await iterator.return?.()
        } catch {
          // Closing a half-consumed member stream must not mask the outcome.
        }
      }
      return
    }
    throw this.exhausted(options.model, members, lastError)
  }

  /**
   * Order the candidates for one request. Health filters both strategies;
   * `quota_aware` then ranks by urgency (members without telemetry, e.g.
   * copilot, score zero and sink to the bottom of their class), while
   * quota-exhausted members stay as a last-resort tail in pool order. The
   * sticky member keeps its lead unless a challenger out-scores it by
   * `switchMargin`.
   */
  private async select(
    poolId: string,
    members: ConcretePoolMember[],
    sessionId: GenerateOptions['sessionId'],
  ): Promise<ConcretePoolMember[]> {
    const usable = members.filter(member =>
      this.options.adapters[member.provider] !== undefined
      && this.options.health.isMemberAvailable(member.provider, member.account, member.model))
    if (usable.length === 0) return []
    const stickyMember = sessionId === undefined
      ? undefined
      : usable.find(member =>
        memberKey(member.provider, member.account, member.model) === this.sticky.get(stickyKey(poolId, sessionId)))
    if (this.options.strategy === 'priority') {
      return stickyMember === undefined
        ? usable
        : [stickyMember, ...usable.filter(member => member !== stickyMember)]
    }
    const quotas = new Map<ConcretePoolMember, MemberQuota>(
      await Promise.all(usable.map(async member => [member, await this.options.usage.quotaFor(member)] as const)),
    )
    const scored = usable.filter(member => quotas.get(member)?.available === true)
    const quotaFull = usable.filter(member => quotas.get(member)?.available === false)
    scored.sort((a, b) => (quotas.get(b)?.urgency ?? 0) - (quotas.get(a)?.urgency ?? 0))
    if (stickyMember !== undefined && scored.includes(stickyMember)) {
      const best = scored[0]
      const stickyUrgency = quotas.get(stickyMember)?.urgency ?? 0
      const bestUrgency = quotas.get(best)?.urgency ?? 0
      if (best === stickyMember || bestUrgency <= stickyUrgency * this.options.switchMargin) {
        // Sticky holds (no challenger beats it by the margin): lead with it.
        scored.splice(scored.indexOf(stickyMember), 1)
        scored.unshift(stickyMember)
      }
    }
    return [...scored, ...quotaFull]
  }

  /** Pin the serving member to the session (with bounded memory). */
  private remember(poolId: string, sessionId: GenerateOptions['sessionId'], member: ConcretePoolMember): void {
    if (sessionId === undefined) return
    const key = stickyKey(poolId, sessionId)
    this.sticky.delete(key)
    if (this.sticky.size >= STICKY_SESSION_LIMIT) {
      const oldest = this.sticky.keys().next()
      if (oldest.done !== true) this.sticky.delete(oldest.value)
    }
    this.sticky.set(key, memberKey(member.provider, member.account, member.model))
  }

  /**
   * The error for an exhausted pool, carrying the earliest recovery hint of
   * THIS pool's members (the health registry is shared across pools, so the
   * hint is scoped to the keys this pool can actually recover through).
   */
  private exhausted(model: string, pool: ConcretePoolMember[], cause?: unknown): LlmError {
    const keys = new Set<string>()
    for (const member of pool) {
      keys.add(memberKey(member.provider, member.account, member.model))
      keys.add(accountKey(member.provider, member.account))
    }
    const recovery = this.options.health.earliestRecovery(keys)
    const retryAfterMs = recovery === undefined ? undefined : Math.max(recovery - Date.now(), 1)
    return new LlmError(
      `pool "${model}" exhausted: every member is unavailable or failed`,
      'RATE_LIMIT',
      {
        ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
        ...cause === undefined ? {} : { cause },
      },
    )
  }
}

function stickyKey(poolId: string, sessionId: NonNullable<GenerateOptions['sessionId']>): string {
  return `${String(sessionId)}|${poolId}`
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined
}

/** Reasoning efforts every member supports (id intersection, first member's order). */
function intersectReasoning(
  resolved: readonly LlmResolvedModelInfo[],
): LlmResolvedModelInfo['reasoning'] | undefined {
  const [first, ...rest] = resolved
  if (first?.reasoning === undefined) return undefined
  const efforts = first.reasoning.efforts.filter(effort =>
    rest.every(info => info.reasoning?.efforts.some(other => other.id === effort.id) === true))
  if (efforts.length === 0) return undefined
  const defaultEffort = first.reasoning.defaultEffort !== undefined
    && efforts.some(effort => effort.id === first.reasoning?.defaultEffort)
    ? first.reasoning.defaultEffort
    : undefined
  return { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } }
}

/** Modalities all members accept; undefined when any member leaves it unknown. */
function intersectModalities(
  resolved: readonly LlmResolvedModelInfo[],
): LlmResolvedModelInfo['inputModalities'] | undefined {
  const [first, ...rest] = resolved
  if (first?.inputModalities === undefined) return undefined
  const modalities = first.inputModalities.filter(modality =>
    rest.every(info => info.inputModalities?.includes(modality) === true))
  // An empty intersection would declare negative capability ("accepts
  // nothing"); report unknown instead — the serving member enforces its own
  // limits at request time.
  return modalities.length === 0 ? undefined : modalities
}
