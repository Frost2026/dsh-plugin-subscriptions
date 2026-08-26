/**
 * Model-family normalization and automatic pool aggregation.
 *
 * Copilot proxies several vendors' models, so the same model family is often
 * reachable through two subscriptions (e.g. `claude-sonnet-4.5` via the
 * Claude subscription directly and via Copilot). Normalizing wire ids to a
 * family key lets the pool aggregate those routes automatically: failover
 * between members of one family keeps the same underlying model, so the
 * switch is transparent to the caller. Members are account-granular — two
 * accounts of one provider pool just like two providers do.
 */

import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../auth/store.js'

/** One pool member: an exact provider/account/model route. */
export interface PoolMemberRef {
  provider: ProviderId
  /** Account key; omitted in configured members to mean "the default account". */
  account?: string
  model: string
}

/** A member with its account resolved (no config indirection left). */
export type ConcretePoolMember = PoolMemberRef & { account: string }

/** One pool: its members plus display metadata for the picker. */
export interface PoolDefinition {
  members: PoolMemberRef[]
  /** Display name of the first member's catalog entry (auto families only). */
  name?: string
  /** Description of the first member's catalog entry (auto families only). */
  description?: string
}

/** One provider's contribution to family aggregation. */
export interface ProviderPoolSource {
  /** Logged-in account keys, default first. */
  accounts: readonly string[]
  /** The provider's model catalog (discovered or static). */
  models: readonly LlmModelInfo[]
}

/**
 * Normalize a wire model id to its family key: lowercase, strip a trailing
 * datestamp (`-20250929`), and unify separators between numeric version
 * segments (`claude-sonnet-4-5` → `claude-sonnet-4.5`). Patch snapshots of
 * one family pool together; distinct minor versions (4.5 vs 4.6) never do.
 * Deliberately conservative: named suffix variants (`-latest`, `-thinking`,
 * `-mini`, …) are NOT stripped — merging ids with different behavior would
 * make a failover visibly change the model, which is exactly what family
 * pools promise not to do. The cost is merely a missed aggregation.
 * @param modelId - the provider's wire model id.
 * @returns the family key used for cross-provider aggregation.
 */
export function modelFamilyKey(modelId: string): string {
  let key = modelId.toLowerCase()
  key = key.replace(/-\d{8}$/, '')
  key = key.replace(/(\d)-(\d)/g, '$1.$2')
  return key
}

/** Providers are tried in catalog order; copilot always pools last. */
const MEMBER_PROVIDER_ORDER: readonly ProviderId[] = ['codex', 'claude', 'grok', 'copilot']

/**
 * Aggregate per-provider catalogs and account lists into family pools. Any
 * family reachable through at least two ACCOUNTS (across providers or
 * within one) becomes a pool; a family served by a single account is just
 * the plain model. Within one provider the first catalog entry of a family
 * wins and its accounts join in order (default first); providers are
 * ordered with copilot — the quota-precious proxy with no usage telemetry —
 * last.
 *
 * Family pool ids are DYNAMIC: when a logout drops a family below two
 * reachable accounts, the pooled model disappears from the catalog until a
 * second account signs in again (a session pinned to it fails with
 * NO_ADAPTER, same as any logged-out provider's model). Users who need an
 * id that survives logouts can pin the members explicitly via the
 * `pool.families` config.
 * @param sources - accounts and model lists per provider (providers with no
 *   accounts list nothing and simply never join a pool).
 * @returns family key → ordered member refs.
 */
export function buildFamilyPools(
  sources: Partial<Record<ProviderId, ProviderPoolSource>>,
): Map<string, PoolDefinition> {
  const byFamily = new Map<string, Map<ProviderId, { model: LlmModelInfo; accounts: readonly string[] }>>()
  for (const provider of MEMBER_PROVIDER_ORDER) {
    const source = sources[provider]
    if (source === undefined || source.accounts.length === 0) continue
    for (const model of source.models) {
      const family = modelFamilyKey(model.id)
      let routes = byFamily.get(family)
      if (routes === undefined) {
        routes = new Map()
        byFamily.set(family, routes)
      }
      if (!routes.has(provider)) routes.set(provider, { model, accounts: source.accounts })
    }
  }
  const pools = new Map<string, PoolDefinition>()
  for (const [family, routes] of byFamily) {
    const members: PoolMemberRef[] = []
    for (const provider of MEMBER_PROVIDER_ORDER) {
      const route = routes.get(provider)
      if (route === undefined) continue
      for (const account of route.accounts) {
        members.push({ provider, account, model: route.model.id })
      }
    }
    if (members.length < 2) continue
    // The pool borrows its first member's display metadata, so a pooled
    // model reads exactly like the direct entry it absorbs.
    const first = routes.get(members[0].provider)?.model
    pools.set(family, {
      members,
      ...first?.name === undefined || first.name === family ? {} : { name: first.name },
      ...first?.description === undefined ? {} : { description: first.description },
    })
  }
  return pools
}
