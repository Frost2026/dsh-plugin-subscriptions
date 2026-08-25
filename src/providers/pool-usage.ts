/**
 * Quota tracking for pool members: polls the providers' usage endpoints
 * (the same normalized `ProviderUsage` shape the Settings page consumes) and
 * turns the windows into a scheduling score.
 *
 * The score is a REQUIRED BURN RATE: the fraction of the window that must be
 * consumed per millisecond for the quota to be exactly used up at reset time
 * (`remaining / timeUntilReset`). Subscription quota does not roll over, so a
 * window about to reset with plenty left is the most urgent to spend — the
 * `quota_aware` strategy therefore prefers the highest-urgency member, which
 * over time converges on every window hitting zero right at its reset.
 */

import { isMissingOrInvalidCredential } from './common.js'
import type { ProviderUsage, UsageWindow } from './common.js'
import type { ProviderId } from '../auth/store.js'
import type { PoolMemberRef } from './pool-family.js'

/** A member is taken out of rotation once any window crosses this fill level. */
export const QUOTA_FULL_PERCENT = 95
/** How long a usage snapshot is trusted before a background refresh. */
export const USAGE_TTL_MS = 5 * 60_000

/** Assumed window length when the provider discloses no `resetsAt`. */
const FALLBACK_HORIZON_MS: Record<UsageWindow['kind'], number> = {
  session: 5 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
  other: 30 * 24 * 60 * 60_000,
}

/** The scheduling view of one member's quota. */
export interface MemberQuota {
  /** False when a window is effectively full or the login is gone. */
  available: boolean
  /** Required burn rate (fraction of window per ms); 0 when unknown. */
  urgency: number
  /** Epoch ms of the snapshot this was computed from; 0 when none. */
  fetchedAt: number
}

interface UsageEntry {
  snapshot: ProviderUsage
  at: number
}

/**
 * Per-provider usage snapshots with in-flight dedupe and
 * stale-while-revalidate refresh. Providers without a usage endpoint
 * (copilot) have no fetcher and score a constant zero urgency — which
 * naturally ranks them behind every measured member.
 */
export class PoolUsageTracker {
  private readonly entries = new Map<ProviderId, UsageEntry>()
  private readonly inflight = new Map<ProviderId, Promise<ProviderUsage>>()

  constructor(
    private readonly fetchers: Partial<Record<ProviderId, () => Promise<ProviderUsage>>>,
    private readonly ttlMs = USAGE_TTL_MS,
  ) {}

  /**
   * The quota view of one member. A cold cache awaits the first fetch; a
   * stale one answers immediately while the refresh serves the NEXT call
   * (member selection must never block on the network mid-conversation).
   * @param member - the pool member to score.
   * @returns availability plus the urgency score.
   */
  async quotaFor(member: PoolMemberRef): Promise<MemberQuota> {
    const fetcher = this.fetchers[member.provider]
    if (fetcher === undefined) return { available: true, urgency: 0, fetchedAt: 0 }
    const entry = this.entries.get(member.provider)
    if (entry !== undefined && Date.now() - entry.at < this.ttlMs) {
      return this.score(member, entry)
    }
    if (entry !== undefined) {
      void this.refresh(member.provider, fetcher).catch(() => undefined)
      return this.score(member, entry)
    }
    try {
      const snapshot = await this.refresh(member.provider, fetcher)
      return this.score(member, { snapshot, at: Date.now() })
    } catch (error: unknown) {
      // Logged out: the member cannot serve at all. Any other failure
      // (network, endpoint rate limit) must not block routing — the member
      // stays available with a zero score, degrading the strategy to plain
      // priority order for it.
      return isMissingOrInvalidCredential(error)
        ? { available: false, urgency: 0, fetchedAt: 0 }
        : { available: true, urgency: 0, fetchedAt: 0 }
    }
  }

  /** Drop the cached snapshot (called on auth changes and quota failures). */
  invalidate(provider: ProviderId): void {
    this.entries.delete(provider)
  }

  /** Run (or join) the single in-flight fetch for one provider. */
  private refresh(provider: ProviderId, fetcher: () => Promise<ProviderUsage>): Promise<ProviderUsage> {
    let pending = this.inflight.get(provider)
    if (pending === undefined) {
      pending = fetcher().then((snapshot) => {
        this.entries.set(provider, { snapshot, at: Date.now() })
        return snapshot
      }).finally(() => {
        this.inflight.delete(provider)
      })
      this.inflight.set(provider, pending)
    }
    return pending
  }

  /** Score one member against a snapshot's windows. */
  private score(member: PoolMemberRef, entry: UsageEntry): MemberQuota {
    const windows = (entry.snapshot.windows ?? []).filter(window => windowApplies(window, member.model))
    let available = true
    let urgency = 0
    for (const window of windows) {
      if (window.usedPercent >= QUOTA_FULL_PERCENT) available = false
      urgency = Math.max(urgency, windowUrgency(window))
    }
    return { available, urgency, fetchedAt: entry.at }
  }
}

/**
 * Whether a window constrains this model: unscoped windows always do; a
 * model-scoped window (Claude's Opus/Sonnet lanes) applies when its scope
 * names the model family.
 */
function windowApplies(window: UsageWindow, model: string): boolean {
  if (window.scope === undefined) return true
  return model.toLowerCase().includes(window.scope.toLowerCase())
}

/** The required burn rate of one window (fraction per ms). */
function windowUrgency(window: UsageWindow, now = Date.now()): number {
  const remaining = Math.max(0, 1 - window.usedPercent / 100)
  const horizon = window.resetsAt !== undefined
    ? Math.max(window.resetsAt - now, 1)
    : FALLBACK_HORIZON_MS[window.kind]
  return remaining / horizon
}
