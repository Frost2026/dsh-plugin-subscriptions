/**
 * The `/subscriptions-auth` host RPC channel the web Settings page drives. The
 * channel is registered only when a host `connection` service exists (the web
 * profile); headless compositions load the plugin without it. All business
 * outcomes are returned as RpcResult values; handlers never throw.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { type ProviderId } from './store.js';
import type { ProviderUsage } from '../providers/common.js';
import type { ProxyConfigView, ProxyDraft, ProxyInput, ProxyTestResult } from '../http.js';
/** The RPC channel this plugin registers on the host connection. */
export declare const SUBSCRIPTIONS_AUTH_CHANNEL = "/subscriptions-auth";
/** Decoded image bytes returned by the `image` endpoint. */
export interface ImageBytesResult {
    mediaType: string;
    dataBase64: string;
}
/** Decoded video bytes returned by the `video` endpoint. */
export interface VideoBytesResult {
    mediaType: string;
    dataBase64: string;
}
/** One session's speed choice: standard routing or the fast (priority) tier. */
export type SpeedTier = 'standard' | 'fast';
/** `speed` endpoint value: the session's choice plus the visibility list. */
export interface SpeedState {
    /** The session's current speed tier (default `standard`). */
    tier: SpeedTier;
    /** Codex model ids whose catalog advertises a fast tier. */
    fastModels: string[];
}
/** Speed state the RPC handler delegates to (in-memory, per session). */
export interface SpeedController {
    /** Current speed state: the session's tier and the fast-capable codex models. */
    speed(sessionId: string): Promise<SpeedState>;
    /** Set one session's speed tier. */
    setSpeed(sessionId: string, tier: SpeedTier): Promise<void>;
}
/** Login state of one provider, as rendered by the Settings page. */
export interface ProviderStatus {
    /** Whether a session exists in the store. */
    loggedIn: boolean;
    /** Whether a login attempt is currently waiting for its code. */
    busy: boolean;
    /** Epoch milliseconds at which the stored access token expires. */
    expiresAt?: number;
    /** Account email or account id, when known. */
    account?: string;
    /** Subscription detail (plan) or the last login error. */
    detail?: string;
}
/** Proxy config operations behind the `proxyGet/proxySet/proxyTest` endpoints. */
export interface ProxyConfigController {
    /** Current proxy configuration (secrets omitted). */
    get(): Promise<ProxyConfigView>;
    /** Validate, persist, and apply one config. */
    set(input: ProxyInput): Promise<ProxyConfigView>;
    /** Probe one destination through the draft (unsaved) or stored proxy. */
    test(payload: {
        url?: string;
        proxy?: ProxyDraft;
    }): Promise<ProxyTestResult>;
}
/** One model's default-effort picker state, as rendered by the Settings page. */
export interface ModelDefaultView {
    /** Wire model id. */
    id: string;
    /** Human-readable display name. */
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
/** One provider's default-effort picker state. */
export interface ModelDefaultsCatalog {
    /** The subscription provider route. */
    provider: ProviderId;
    /** Models the picker can configure, in catalog order. */
    models: ModelDefaultView[];
}
/** Default-effort picker operations behind the `modelDefaults/setModelDefault` endpoints. */
export interface ModelDefaultsController {
    /** Per-provider picker state for the Settings page. */
    catalog(): Promise<ModelDefaultsCatalog[]>;
    /** Set one model's configured default effort; undefined clears the override. */
    set(provider: ProviderId, model: string, effort: string | undefined): Promise<void>;
}
/** Provider-agnostic auth operations the RPC handler delegates to. */
export interface AuthController {
    /** Current status of one provider. */
    status(provider: ProviderId): Promise<ProviderStatus>;
    /**
     * Start a background login attempt.
     * @returns the authorize URL for the user's browser; device-flow providers
     *   (copilot) also return the `userCode` the user types at that URL.
     * @throws when an attempt is already running for this provider.
     */
    login(provider: ProviderId): Promise<{
        authorizeUrl: string;
        userCode?: string;
    }>;
    /**
     * Feed a pasted callback URL or bare code into the pending attempt.
     * @throws when no attempt is pending or the input is unusable.
     */
    manual(provider: ProviderId, input: string): Promise<void>;
    /** Abort the pending attempt; a no-op when none is pending. */
    cancel(provider: ProviderId): Promise<void>;
    /** Delete the stored session. */
    logout(provider: ProviderId): Promise<void>;
    /**
     * Current subscription usage of one provider.
     * @param signal - caller cancellation from the RPC transport.
     * @returns `{ supported: false }` when the provider has no usage endpoint.
     * @throws when logged out or the usage lookup fails.
     */
    usage(provider: ProviderId, signal: AbortSignal): Promise<ProviderUsage>;
    /**
     * Read one image attachment's bytes for inline display.
     * @param ref - the full durable reference (`readImage` verifies against it).
     * @param signal - caller cancellation from the RPC transport.
     * @returns the media type and base64-encoded bytes.
     * @throws when no attachment service is mounted or the read fails.
     */
    readImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<ImageBytesResult>;
    /**
     * Read one generated video's bytes for inline playback.
     * @param name - bare MP4 file name inside the plugin's videos directory
     *   (validated against {@link VIDEO_NAME_PATTERN}; never a path).
     * @param signal - caller cancellation from the RPC transport.
     * @returns the media type and base64-encoded bytes.
     * @throws when the file does not exist or cannot be read.
     */
    readVideo(name: string, signal: AbortSignal): Promise<VideoBytesResult>;
}
/**
 * Register the `/subscriptions-auth` RPC channel when a host connection exists.
 * @param ctx - the plugin context (headless profiles have no `connection`).
 * @param controller - the auth operations backing the endpoints.
 * @param speed - the per-session speed-tier state backing the Speed toggle.
 * @param proxy - optional proxy-config controller backing `proxyGet`/`proxySet`/`proxyTest`.
 * @param modelDefaults - optional per-model default-effort state backing `modelDefaults`/`setModelDefault`.
 */
export declare function registerAuthRpc(ctx: Context, controller: AuthController, speed: SpeedController, proxy?: ProxyConfigController | undefined, modelDefaults?: ModelDefaultsController | undefined): void;
