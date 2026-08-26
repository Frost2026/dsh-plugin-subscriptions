import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client';
import type { SubscriptionsKey } from './locales.js';
/** Subscription provider ids, fixed by the node half's OAuth adapters. */
export type SubscriptionProvider = 'codex' | 'claude' | 'grok' | 'copilot';
/** One provider's login state as answered by the `status` endpoint. */
export interface ProviderStatus {
    loggedIn: boolean;
    busy: boolean;
    expiresAt?: number;
    account?: string;
    detail?: string;
}
/** One rate-limit window as answered by the `usage` endpoint. */
export interface UsageWindow {
    kind: 'session' | 'weekly' | 'other';
    scope?: string;
    usedPercent: number;
    resetsAt?: number;
}
/** `usage` endpoint value: the node half owns this shape. */
export interface ProviderUsage {
    supported: boolean;
    windows?: UsageWindow[];
    plan?: string;
}
/** One model's default-effort picker state as answered by `modelDefaults`. */
export interface ModelDefaultView {
    id: string;
    name: string;
    /** Advertised effort levels, in catalog order (empty when the model has no reasoning). */
    efforts: {
        id: string;
        name: string;
    }[];
    /** The user-configured default effort, when set. */
    configured?: string;
    /** The effective default effort (configured or advertised), when any. */
    effective?: string;
}
/** `modelDefaults` endpoint value: one provider's picker state. */
export interface ModelDefaultsCatalog {
    provider: SubscriptionProvider;
    models: ModelDefaultView[];
}
/** `proxyGet` endpoint value: the node half owns this shape (no secrets). */
export interface ProxyConfigView {
    enabled: boolean;
    url: string;
    username?: string;
    passwordSet: boolean;
    bypass: string[];
    error?: string;
}
/** `proxyTest` endpoint value. */
export interface ProxyTestResult {
    ok: boolean;
    viaProxy: boolean;
    status?: number;
    latencyMs?: number;
    error?: string;
}
/** Injected dependencies of {@link SubscriptionsSection} (slot `inject`). */
export interface SubscriptionsSectionInjected {
    /** Generic logical-RPC caller over the Connection transport. */
    rpc: ConnectionHandle['rpc'];
    /** Section copy: translate a 'settings.subscriptions' key with `{name}` template params. */
    t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string;
}
/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type SubscriptionsSectionProps = Partial<SubscriptionsSectionInjected>;
/**
 * Call one `/subscriptions-auth` endpoint and unwrap the business result.
 * Shared by the settings section and the composer Speed toggle.
 * @param rpc - Connection RPC caller.
 * @param endpoint - channel-relative endpoint.
 * @param payload - channel-owned request payload.
 * @returns the success value, cast by the caller to the endpoint's shape.
 */
export declare function callSubscriptionsAuth<T>(rpc: ConnectionHandle['rpc'], endpoint: string, payload: unknown): Promise<T>;
/** What one provider's collapsible default-effort section renders. */
export interface ModelDefaultsView {
    /** Models with reasoning levels, after the name filter — one row each. */
    shown: ModelDefaultView[];
    /** Models with reasoning levels before filtering (the header total). */
    total: number;
    /** How many of those carry a user override (the header count). */
    overridden: number;
    /** Models without reasoning levels: one count line, never a row each. */
    withoutEfforts: number;
    /** Whether the list is long enough to deserve a filter box. */
    showFilter: boolean;
}
/**
 * Derive one provider's default-effort section from its catalog and filter.
 * Pure so the collapsed-header counts and the filter stay testable without a
 * DOM: rows come only from models that advertise levels, the count of the rest
 * rides as one line, and the filter matches display name or model id.
 * @param models - the provider's catalog models, or undefined while loading.
 * @param filter - the raw filter input (trimmed and lowercased here).
 * @returns the section's rows and header counts.
 */
export declare function deriveModelDefaultsView(models: readonly ModelDefaultView[] | undefined, filter: string): ModelDefaultsView;
/**
 * The Subscriptions settings page component.
 * @param props - the slot inject face ({@link SubscriptionsSectionInjected}).
 * @returns the section body, or a notice while the RPC face is absent.
 */
export declare function SubscriptionsSection(props: SubscriptionsSectionProps): import("react").JSX.Element;
