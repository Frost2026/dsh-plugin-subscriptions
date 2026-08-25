/**
 * Model-family normalization and automatic pool aggregation.
 *
 * Copilot proxies several vendors' models, so the same model family is often
 * reachable through two subscriptions (e.g. `claude-sonnet-4.5` via the
 * Claude subscription directly and via Copilot). Normalizing wire ids to a
 * family key lets the pool aggregate those routes automatically: failover
 * between members of one family keeps the same underlying model, so the
 * switch is transparent to the caller.
 */

import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { ProviderId } from '../auth/store.js'

/** One pool member: an exact provider/model route. */
export interface PoolMemberRef {
  provider: ProviderId
  model: string
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
 * Aggregate per-provider catalogs into family pools. Only families reachable
 * through at least two providers become pools (a single-member family is
 * just the plain model). Within one provider the first catalog entry of a
 * family wins; members are ordered with copilot — the quota-precious proxy
 * with no usage telemetry — last.
 *
 * Family pool ids are DYNAMIC: when a logout drops a family below two
 * reachable routes, the pooled model disappears from the catalog until the
 * provider is signed in again (a session pinned to it fails with
 * NO_ADAPTER, same as any logged-out provider's model). Users who need an
 * id that survives logouts can pin the members explicitly via the
 * `pool.families` config.
 * @param catalogs - model lists per provider (logged-out providers list
 *   nothing and simply never join a pool).
 * @returns family key → ordered member refs.
 */
export function buildFamilyPools(
  catalogs: Partial<Record<ProviderId, readonly LlmModelInfo[]>>,
): Map<string, PoolMemberRef[]> {
  const byFamily = new Map<string, Map<ProviderId, string>>()
  for (const provider of MEMBER_PROVIDER_ORDER) {
    const models = catalogs[provider]
    if (models === undefined) continue
    for (const model of models) {
      const family = modelFamilyKey(model.id)
      let routes = byFamily.get(family)
      if (routes === undefined) {
        routes = new Map()
        byFamily.set(family, routes)
      }
      if (!routes.has(provider)) routes.set(provider, model.id)
    }
  }
  const pools = new Map<string, PoolMemberRef[]>()
  for (const [family, routes] of byFamily) {
    if (routes.size < 2) continue
    const members: PoolMemberRef[] = []
    for (const provider of MEMBER_PROVIDER_ORDER) {
      const model = routes.get(provider)
      if (model !== undefined) members.push({ provider, model })
    }
    pools.set(family, members)
  }
  return pools
}
