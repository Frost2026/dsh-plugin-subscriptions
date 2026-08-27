/**
 * dsh-plugin-subscriptions: register OAuth-subscription LLM providers
 * (ChatGPT/Codex, Claude, Grok, GitHub Copilot) on `ctx.llm`, and expose the `/subscriptions-auth`
 * RPC channel the web Settings page uses to run the logins. The token store
 * lives at `~/.dsh/plugins/subscriptions/auth.json`; the channel registers only when
 * a host `connection` service exists, so headless compositions load fine.
 * @module dsh-plugin-subscriptions
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ProviderId } from './auth/store.js';
import type { ModelEntry } from './providers/common.js';
import type { PoolMemberRef } from './providers/pool-family.js';
export type { ModelEntry, ProviderUsage, UsageWindow } from './providers/common.js';
export type { ProviderStatus } from './auth/rpc.js';
export type { ClaudeSession, CodexSession, CopilotSession, GrokSession, ProviderId } from './auth/store.js';
export declare const name = "dsh-plugin-subscriptions";
export declare const inject: string[];
/** Default maximum provider idle time while one stream read is outstanding. */
export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Bound on one pool quota poll — member selection must not hang on a usage endpoint. */
export declare const POOL_USAGE_TIMEOUT_MS = 10000;
export { withTimeout } from './providers/common.js';
/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
    /** Provider routes to register; defaults to all three. */
    providers?: ProviderId[];
    /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
    streamIdleTimeoutMs?: number;
    /** Advisory model catalogs overriding the built-in defaults, per provider. */
    models?: {
        codex?: ModelEntry[];
        claude?: ModelEntry[];
        grok?: ModelEntry[];
        copilot?: ModelEntry[];
    };
    /** Same-subscription account pools (and optional extra tier models). */
    pool?: {
        /** Enable account pooling (default true; needs ≥2 accounts of one provider). */
        enabled?: boolean;
        /** Member selection: plain priority failover, or quota-aware urgency scheduling. */
        strategy?: 'priority' | 'quota_aware';
        /** A challenger must out-score the sticky member by this factor to take over (default 2). */
        switchMargin?: number;
        /** Auto-pool every catalog model across a provider's logged-in accounts (default true). */
        autoAccounts?: boolean;
        /** @deprecated Use {@link autoAccounts}. */
        autoFamilies?: boolean;
        /** Explicit account lists for one catalog model (same provider); replaces the auto pool. */
        families?: Record<string, PoolMemberRef[]>;
        /** Extra picker entries with heterogeneous fallbacks, listed under the first member's provider. */
        tiers?: Record<string, PoolMemberRef[]>;
    };
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
