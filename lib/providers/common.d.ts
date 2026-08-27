/**
 * Plumbing shared by the three subscription adapters: HTTP error mapping, a
 * stream idle watchdog, fetch failure classification, OAuth endpoint errors,
 * and the per-provider {@link TokenManager} that owns session freshness.
 * Concurrent refreshes for one provider coalesce behind a single in-flight
 * promise (`inflight`), so a rotating refresh token is never spent twice.
 */
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
/** One configured model catalog entry. */
export interface ModelEntry {
    /** Wire model id; must be non-empty. */
    id: string;
    /** Selector label; defaults to the id. */
    name?: string;
    /** Known combined request/response context capacity. */
    contextWindow?: number;
    /** Per-request output cap for this model. */
    maxTokens?: number;
    /** Accepted request modalities; when set, wins over the provider default. */
    inputModalities?: ('text' | 'image')[];
    /**
     * Force this model's upstream protocol. Only the copilot adapter consumes
     * the semantics; the union is inlined here to avoid a circular import of
     * the copilot module's `CopilotWire`.
     */
    wire?: 'chat-completions' | 'responses';
}
/**
 * Validate a configured model catalog (mirrors llm-deepseek's resolveModels).
 * @param models - raw configured entries.
 * @param label - diagnostic prefix naming the provider.
 * @returns the validated entries.
 */
export declare function validateModels(models: readonly ModelEntry[], label: string): ModelEntry[];
/**
 * Build an LlmError from a non-2xx provider response, reading and truncating
 * the body for the message and mapping the status to a stable code.
 * @param response - the failed response.
 * @param label - diagnostic prefix naming the provider API.
 * @returns the classified error.
 */
export declare function httpLlmError(response: Response, label: string): Promise<LlmError>;
/** An idle watchdog: aborts its signal when no SSE activity arrives within the timeout. */
export interface IdleWatchdog {
    /** Signal to pass to fetch and body reads; aborts on caller cancel or idle expiry. */
    readonly signal: AbortSignal;
    /** Reset the idle timer (call on every received SSE event). */
    pulse(): void;
    /** Stop the timer and detach from the caller signal. */
    stop(): void;
    /** Whether the last abort came from idle expiry rather than caller cancellation. */
    timedOut(): boolean;
}
/**
 * Create an idle watchdog chained to the caller's signal.
 * @param caller - the request's own abort signal, when present.
 * @param timeoutMs - maximum idle interval while a stream read is outstanding.
 * @returns the watchdog; always {@link IdleWatchdog.stop} it when the stream ends.
 */
export declare function idleWatchdog(caller: AbortSignal | undefined, timeoutMs: number): IdleWatchdog;
/**
 * Classify a thrown fetch failure. Caller cancellation maps to ABORTED, idle
 * expiry to TIMEOUT, and everything else (DNS, TLS, refused connection) to
 * TRANSPORT with the cause chained.
 * @param label - diagnostic prefix naming the provider API.
 * @param error - the thrown value.
 * @param watchdog - the request's idle watchdog.
 * @param caller - the request's own abort signal, when present.
 * @returns the classified error.
 */
export declare function mapFetchFailure(label: string, error: unknown, watchdog: IdleWatchdog, caller: AbortSignal | undefined): LlmError;
/** OAuth token-endpoint failure carrying the provider's `error` code when it sent one. */
export declare class OAuthEndpointError extends Error {
    /** HTTP status of the token endpoint response. */
    readonly status: number;
    /** The provider's OAuth `error` code (e.g. `invalid_grant`), when present. */
    readonly oauthCode: string | undefined;
    constructor(message: string, status: number, oauthCode?: string);
}
/**
 * Read an OAuth JSON error body into an {@link OAuthEndpointError}.
 * @param response - the failed token-endpoint response.
 * @param label - diagnostic prefix naming the provider.
 * @returns the error to throw.
 */
export declare function oauthEndpointError(response: Response, label: string): Promise<OAuthEndpointError>;
/** A session fresh enough to serve a request without a refresh. */
interface TimedSession {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}
/** Provider hooks the token manager needs. */
export interface TokenManagerOptions<S extends TimedSession> {
    /** Human-readable provider name for error messages. */
    displayName: string;
    /** Refresh this long before `expiresAt`. */
    preemptMs: number;
    load(): Promise<S | undefined>;
    save(session: S): Promise<void>;
    remove(): Promise<void>;
    /** Perform the provider's refresh-token grant. */
    refresh(session: S): Promise<S>;
    /** Whether a refresh failure is permanent (re-login required). */
    isPermanent(error: unknown): boolean;
    /** Called after a permanent refresh failure deleted the stored session. */
    onRemoved?(): void;
}
/**
 * Per-provider session freshness: loads the stored session, refreshes
 * proactively inside the preempt window or on demand after a 401, and
 * coalesces concurrent refreshes behind one in-flight promise. Permanent
 * refresh failures delete the stored session and surface INVALID_CREDENTIAL
 * with a re-login hint; transient failures fall back to a still-valid token.
 */
export declare class TokenManager<S extends TimedSession> {
    private readonly options;
    private inflight;
    constructor(options: TokenManagerOptions<S>);
    /**
     * Read the stored session without any refresh side effect. Catalog queries
     * (`listModels`) use this to decide whether the provider is logged in.
     * @returns the stored session, or `undefined` when logged out.
     */
    peek(): Promise<S | undefined>;
    /**
     * Whether a session is currently stored (cheap; never refreshes).
     * @returns true when logged in.
     */
    hasSession(): Promise<boolean>;
    /**
     * Resolve a usable session, refreshing proactively or on demand.
     * @param forceRefresh - refresh regardless of expiry (used after a 401).
     * @returns the persisted session to send.
     * @throws LlmError MISSING_CREDENTIAL when logged out, INVALID_CREDENTIAL
     *   when the refresh grant is permanently rejected.
     */
    session(forceRefresh?: boolean): Promise<S>;
    private doRefresh;
}
/** Fetch signature adapters accept for discovery calls (injectable for tests). */
export type FetchFn = typeof fetch;
/** Bound on one account catalog fetch or usage poll — a hang must not block the picker. */
export declare const DISCOVERY_TIMEOUT_MS = 10000;
/**
 * Run `work` with an aborting signal. Resolves undefined when the timeout
 * fires (the fetch is aborted); other failures propagate.
 */
export declare function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T | undefined>;
/** One rate-limit window reported by a provider's usage endpoint. */
export interface UsageWindow {
    /** Window kind: `session` for the short rolling window, `weekly` for the 7-day one. */
    kind: 'session' | 'weekly' | 'other';
    /** Model scope for model-specific windows (e.g. `Opus`), when the provider names one. */
    scope?: string;
    /** Percent of the window already consumed (0–100). */
    usedPercent: number;
    /** Epoch milliseconds at which the window resets, when the provider discloses it. */
    resetsAt?: number;
}
/** Subscription usage of one provider, as served by the `usage` RPC endpoint. */
export interface ProviderUsage {
    /** False when the provider has no usage endpoint (grok); windows are absent then. */
    supported: boolean;
    /** Usage windows in display order. */
    windows?: UsageWindow[];
    /** Plan name the usage endpoint reported, when present. */
    plan?: string;
}
/** One model discovered from a provider's live model-list endpoint. */
export interface DiscoveredModel {
    /** Wire model id. */
    id: string;
    /** Human-readable display name. */
    name: string;
    description?: string;
    /** Advertised combined context capacity in tokens. */
    contextWindow?: number;
    /** Provider sort hint; lower sorts earlier. */
    priority?: number;
    /** Advertised reasoning efforts, when the provider discloses them. */
    reasoning?: {
        efforts: {
            id: ReasoningEffortId;
            name: string;
            description?: string;
        }[];
        defaultEffort?: ReasoningEffortId;
    };
    /** Accepted request modalities the endpoint advertised (e.g. Copilot's vision support flag). */
    inputModalities?: ('text' | 'image')[];
    /** Claude-specific: which extended-thinking wire shape this model accepts. */
    thinkingType?: 'enabled' | 'adaptive';
    /** Codex-specific: the catalog advertises a fast (priority) service tier. */
    fastTier?: boolean;
    /** Copilot-specific: which upstream protocol the model's endpoints speak. */
    copilotWire?: 'chat-completions' | 'responses';
    /**
     * Copilot-specific: the catalog also lists `/responses` for this model
     * (dual-protocol entries, e.g. gpt-5.4), so a chat-wire request may reroute
     * there when it combines function tools with a reasoning effort.
     */
    copilotResponses?: boolean;
}
/** Display name for a wire reasoning-effort identifier. */
export declare function effortDisplayName(effort: string): string;
/** The reasoning-block shape every caller passes to {@link mergeReasoning}. */
export interface ReasoningBlock {
    efforts: readonly {
        id: ReasoningEffortId;
        name: string;
        description?: string;
    }[];
    defaultEffort?: ReasoningEffortId;
}
/**
 * Fold a configured per-model default effort into a reasoning block. The
 * configured value wins over the discovered/built-in default; the DSH
 * runtime invariant `defaultEffort ∈ efforts` is preserved by appending the
 * configured level when the base set does not advertise it (the runtime
 * rejects an unknown default with `INVALID_MODEL_REASONING`).
 * @param configuredDefault - the user-configured default effort id, or undefined.
 * @param base - the discovered/built-in reasoning block, or undefined.
 * @returns the merged block, or undefined when neither side contributes one.
 */
export declare function mergeReasoning(configuredDefault: string | undefined, base: ReasoningBlock | undefined): DiscoveredModel['reasoning'] | undefined;
/**
 * First account catalog that lists `model` (callers pass default-first).
 * One failing lookup sits that account out so a sibling's metadata still
 * resolves — the same isolation as the picker catalog union.
 */
export declare function discoverAcrossAccounts(accounts: readonly string[], lookup: (account: string) => Promise<DiscoveredModel | undefined>): Promise<DiscoveredModel | undefined>;
/** How long a discovered catalog is trusted before re-fetching. */
export declare const DISCOVERY_TTL_MS: number;
/** A durable snapshot of one provider's discovered catalog. */
export interface CatalogSnapshot {
    /** Epoch milliseconds of the successful fetch that produced it. */
    at: number;
    models: DiscoveredModel[];
}
/** The durable half of a {@link ModelCatalogCache} (the models.json store). */
export interface CatalogPersistence {
    /** The last persisted snapshot, or undefined when absent or unusable. */
    load(): Promise<CatalogSnapshot | undefined>;
    /** Persist a fresh snapshot (write-through after every successful fetch). */
    save(snapshot: CatalogSnapshot): Promise<void>;
    /** Drop the persisted snapshot (a 401 proved the credential changed). */
    clear(): Promise<void>;
}
/**
 * Cache for one provider's discovered model catalog. The TTL only decides
 * when to REFRESH; it never makes the cache forget: capability metadata
 * (reasoning efforts) must stay stable for a session that selected an effort,
 * or mid-conversation calls fail UNSUPPORTED_REASONING_EFFORT the moment the
 * cache goes stale. `listModels` awaits freshness via {@link get};
 * `resolveModel` uses {@link resolve}, which serves the last-known catalog
 * while a stale entry refreshes in the background, and only awaits the fetch
 * when nothing is known yet. An optional {@link CatalogPersistence} seeds the
 * last-known state across restarts and receives every successful fetch. A 401
 * that still fails after a forced token refresh must call {@link invalidate}.
 */
export declare class ModelCatalogCache {
    private readonly persistence?;
    private readonly ttlMs;
    private entry;
    private inflight;
    /** Settles once the persisted snapshot (when any) has been considered. */
    private seeded;
    /** Set by {@link invalidate} so an in-flight disk read cannot resurrect dropped state. */
    private seedDisabled;
    /** Bumped by {@link invalidate} so a loser in-flight fetch cannot write back. */
    private generation;
    constructor(persistence?: CatalogPersistence | undefined, ttlMs?: number);
    /**
     * The cached catalog when fresh, without fetching.
     * @returns the cached models, or `undefined` when absent or stale.
     */
    cached(): readonly DiscoveredModel[] | undefined;
    /**
     * The last successfully fetched catalog, ignoring TTL. Used to carry
     * capability metadata forward when a later fetch cannot re-enrich.
     * @returns the last-known models, or `undefined` when nothing has been stored.
     */
    lastKnown(): readonly DiscoveredModel[] | undefined;
    /** Load the persisted snapshot once; a fetch or invalidate that landed first wins. */
    private ensureSeeded;
    /** Run (or join) the single in-flight fetch, updating memory and disk on success. */
    private refresh;
    /**
     * Return the cached catalog when fresh, otherwise fetch and cache it.
     * @param fetcher - performs the provider's model-list request.
     * @returns the discovered models.
     * @throws the fetcher's failure (the `listModels` caller warns and falls back).
     */
    get(fetcher: () => Promise<DiscoveredModel[]>): Promise<readonly DiscoveredModel[]>;
    /**
     * The models for capability resolution. A fresh cache answers directly; a
     * stale one answers immediately from the last-known catalog while a
     * background refresh runs (a mid-conversation `resolveModel` must neither
     * block on nor fail with the network); a cold cache awaits one fetch.
     * @param fetcher - performs the provider's model-list request.
     * @returns the models, or `undefined` when nothing is known (the caller
     *   falls back to its static metadata). Never throws.
     */
    resolve(fetcher: () => Promise<DiscoveredModel[]>): Promise<readonly DiscoveredModel[] | undefined>;
    /** Drop the cached catalog (e.g. after a 401 proved the credential changed). */
    invalidate(): void;
}
/** Whether discovery failed because the stored login is gone. */
export declare function isMissingOrInvalidCredential(error: unknown): boolean;
/** Whether discovery stopped because the caller cancelled or the timeout fired. */
export declare function isDiscoveryAborted(error: unknown, signal?: AbortSignal): boolean;
/**
 * Run a catalog fetch, retrying once after a forced token refresh when the
 * first attempt is a 401/AUTH. Only {@link ModelCatalogCache.invalidate}s
 * when the retry is also an auth failure, so a refresh race cannot erase
 * last-known capability metadata.
 */
export declare function discoverOrRetryAuth<T>(session: (forceRefresh?: boolean) => Promise<unknown>, catalog: ModelCatalogCache, run: () => Promise<T>): Promise<T>;
export {};
