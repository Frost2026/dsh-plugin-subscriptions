/**
 * dsh-plugin-subscriptions: register OAuth-subscription LLM providers
 * (ChatGPT/Codex, Claude, Grok, GitHub Copilot) on `ctx.llm`, and expose the `/subscriptions-auth`
 * RPC channel the web Settings page uses to run the logins. The token store
 * lives at `~/.dsh/plugins/subscriptions/auth.json`; the channel registers only when
 * a host `connection` service exists, so headless compositions load fine.
 * @module dsh-plugin-subscriptions
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, LlmAdapter, LlmModelInfo } from '@deepseek-ai/dsh-llm'
// Type-only: activates the `ctx.tools` Context merge for the inject block.
import type {} from '@deepseek-ai/dsh-tools'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { OAuthFlowManager, type OAuthAttempt } from './auth/oauth-flow.js'
import { DeviceFlowManager, type DeviceAttempt } from './auth/device-flow.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readClaudeCodeCredentials, refreshClaudeSynced } from './auth/claude-code-creds.js'
import { registerAuthRpc } from './auth/rpc.js'
import type {
  AuthController,
  ImageBytesResult,
  ProviderStatus,
  SpeedController,
  SpeedTier,
  VideoBytesResult,
} from './auth/rpc.js'
import {
  deleteSession,
  getSession,
  saveSession,
  PROVIDER_IDS,
} from './auth/store.js'
import type {
  ClaudeSession,
  CodexSession,
  CopilotSession,
  GrokSession,
  ProviderId,
  SessionMap,
  StoredSession,
} from './auth/store.js'
import { TokenManager, validateModels } from './providers/common.js'
import type { ModelEntry, ProviderUsage } from './providers/common.js'
import { catalogStore } from './providers/catalog-store.js'
import { PoolAdapter } from './providers/pool.js'
import { buildFamilyPools } from './providers/pool-family.js'
import type { PoolMemberRef } from './providers/pool-family.js'
import { PoolHealthRegistry } from './providers/pool-health.js'
import { PoolUsageTracker } from './providers/pool-usage.js'
import {
  CodexAdapter,
  codexFlow,
  CODEX_PREEMPT_MS,
  codexProfileClaims,
  exchangeCodexCode,
  fetchCodexUsage,
  isCodexPermanentRefreshError,
  refreshCodex,
} from './providers/codex.js'
import {
  ClaudeAdapter,
  claudeFlow,
  CLAUDE_PREEMPT_MS,
  exchangeClaudeCode,
  fetchClaudeUsage,
  isClaudePermanentRefreshError,
  refreshClaude,
} from './providers/claude.js'
import {
  GrokAdapter,
  grokFlow,
  GROK_PREEMPT_MS,
  exchangeGrokCode,
  fetchGrokUsage,
  isGrokPermanentRefreshError,
  refreshGrok,
} from './providers/grok.js'
import {
  CopilotAdapter,
  COPILOT_PREEMPT_MS,
  completeCopilotLogin,
  copilotDeviceFlow,
  isCopilotPermanentRefreshError,
  refreshCopilot,
} from './providers/copilot.js'
import { createXSearchTool } from './tools/x-search.js'
import { createImageGenerateTool } from './tools/image-generate.js'
import { createVideoGenerateTool, videosDirectory } from './tools/video-generate.js'
import { proxiedFetch, proxyGetConfig, proxySetConfig, proxyTestConnection } from './http.js'

export type { ModelEntry, ProviderUsage, UsageWindow } from './providers/common.js'
export type { ProviderStatus } from './auth/rpc.js'
export type { ClaudeSession, CodexSession, CopilotSession, GrokSession, ProviderId } from './auth/store.js'

export const name = 'dsh-plugin-subscriptions'
export const inject = ['llm']

/** Default maximum provider idle time while one stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** The virtual provider route the pool adapter registers on. */
export const POOL_ROUTE = 'pool'

/** Bound on one pool quota poll — member selection must not hang on a usage endpoint. */
export const POOL_USAGE_TIMEOUT_MS = 10_000

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Provider routes to register; defaults to all three. */
  providers?: ProviderId[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Advisory model catalogs overriding the built-in defaults, per provider. */
  models?: {
    codex?: ModelEntry[]
    claude?: ModelEntry[]
    grok?: ModelEntry[]
    copilot?: ModelEntry[]
  }
  /** Cross-subscription model pools on the virtual `pool` route. */
  pool?: {
    /** Register the pool route at all (default true; needs ≥2 providers). */
    enabled?: boolean
    /** Member selection: plain priority failover, or quota-aware urgency scheduling. */
    strategy?: 'priority' | 'quota_aware'
    /** A challenger must out-score the sticky member by this factor to take over (default 2). */
    switchMargin?: number
    /** Aggregate same-family models across providers automatically (default true). */
    autoFamilies?: boolean
    /** Explicit family pools; an id colliding with an auto-aggregated family replaces it. */
    families?: Record<string, PoolMemberRef[]>
    /** Heterogeneous tier pools (failover switches models), by pool id. */
    tiers?: Record<string, PoolMemberRef[]>
  }
}

const providerIdSchema = z.union(['codex', 'claude', 'grok', 'copilot'])
const modelEntrySchema: z<ModelEntry> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(['text', 'image'])),
  wire: z.union(['chat-completions', 'responses']),
})

const poolMemberSchema: z<PoolMemberRef> = z.object({
  provider: providerIdSchema.required(),
  model: z.string().required(),
})

export const Config: z<Config> = z.object({
  providers: z.array(providerIdSchema).default(['codex', 'claude', 'grok', 'copilot']),
  streamIdleTimeoutMs: z.number().min(1).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  models: z.object({
    codex: z.array(modelEntrySchema),
    claude: z.array(modelEntrySchema),
    grok: z.array(modelEntrySchema),
    copilot: z.array(modelEntrySchema),
  }),
  pool: z.object({
    enabled: z.boolean().default(true),
    strategy: z.union(['priority', 'quota_aware']).default('quota_aware'),
    switchMargin: z.number().min(1).default(2),
    autoFamilies: z.boolean().default(true),
    families: z.dict(z.array(poolMemberSchema)),
    tiers: z.dict(z.array(poolMemberSchema)),
  }),
})

/** Built-in catalogs used when the config does not override a provider's models. */
const DEFAULT_MODELS: Record<ProviderId, ModelEntry[]> = {
  codex: [
    { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.1', name: 'GPT-5.1' },
  ],
  claude: [
    { id: 'claude-opus-5', name: 'Claude Opus 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-fable-5', name: 'Claude Fable 5', maxTokens: 128_000, contextWindow: 1_000_000 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', maxTokens: 64_000 },
  ],
  grok: [
    { id: 'grok-4', name: 'Grok 4' },
    { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast Reasoning' },
    { id: 'grok-code-fast-1', name: 'Grok Code Fast 1' },
  ],
  // Static fallback only: the live /models catalog (with per-model vision
  // flags and context windows) wins whenever discovery succeeds.
  copilot: [
    { id: 'gpt-4.1', name: 'GPT-4.1', inputModalities: ['text', 'image'] },
    { id: 'gpt-4o', name: 'GPT-4o', inputModalities: ['text', 'image'] },
    { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', inputModalities: ['text', 'image'] },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', inputModalities: ['text', 'image'] },
  ],
}

/** Validate and detach the model catalog for every provider. */
function resolveCatalog(models: Config['models']): Record<ProviderId, ModelEntry[]> {
  const resolve = (provider: ProviderId): ModelEntry[] => {
    // Schemastery injects `[]` for omitted array fields, so an empty list
    // cannot be told apart from an absent one: both mean the built-ins.
    const configured = models?.[provider]
    const entries = configured !== undefined && configured.length > 0 ? configured : DEFAULT_MODELS[provider]
    return validateModels(entries, `${name}: models.${provider}`)
  }
  return { codex: resolve('codex'), claude: resolve('claude'), grok: resolve('grok'), copilot: resolve('copilot') }
}

/** The display account of a stored session, for the status endpoint. */
function accountOf(provider: ProviderId, session: StoredSession | undefined): string | undefined {
  if (session === undefined) return undefined
  switch (provider) {
    case 'codex': {
      const codex = session as CodexSession
      // Sessions stored before identity claims were persisted still carry the
      // id token: decode the email on the fly instead of forcing a re-login.
      return codex.emailAddress ?? codexProfileClaims(codex.idToken).emailAddress ?? codex.accountId
    }
    case 'claude': return (session as ClaudeSession).emailAddress
    case 'grok': return (session as GrokSession).account
    case 'copilot': return (session as CopilotSession).account
  }
}

/** Per-provider usage lookup; providers without a usage endpoint are absent. */
type UsageFetchers = Partial<Record<ProviderId, (signal: AbortSignal) => Promise<ProviderUsage>>>

/**
 * Auth operations behind the `/subscriptions-auth` RPC channel: start/complete
 * OAuth attempts in the background, feed pasted codes, cancel, log out, and
 * answer usage lookups.
 *
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export class SubscriptionsAuthController implements AuthController {
  /** Last login failure per provider, surfaced as `detail` until the next success. */
  private lastError = new Map<ProviderId, string>()
  /**
   * Device-flow logins whose poll already settled but whose token exchange +
   * persist is still running. Between those two moments the attempt is gone
   * from the flow manager (busy=false) while no session exists yet
   * (loggedIn=false) — counting this window as busy keeps the Settings page
   * polling until the card can show the real outcome.
   */
  private finalizing = new Set<ProviderId>()

  /** In-flight OAuth completions, one per provider at most. */
  private completions = new Map<ProviderId, Promise<void>>()

  /**
   * Per-provider claim counter. Everything that takes ownership of a
   * provider's session — starting a login, importing Claude Code credentials,
   * cancelling, logging out — bumps it, and a session write carrying an older
   * number has been superseded and is dropped.
   *
   * The counter is what makes a late OAuth completion safe: an attempt leaves
   * `OAuthFlowManager`'s pending map the moment its callback delivers the
   * code, while the token exchange that follows can still run for seconds. For
   * that whole window `pending(provider)?.cancel()` is a no-op, so ownership
   * cannot be read off the flow manager.
   */
  private claims = new Map<ProviderId, number>()

  constructor(
    private readonly flows: OAuthFlowManager,
    /** Device-flow attempts (copilot); polled in the background like the loopback flows. */
    private readonly deviceFlows: DeviceFlowManager,
    /** Announces a provider's auth-state change so catalog readers re-query (fires `llm/adapters-updated`). */
    private readonly onAuthChanged: (provider: ProviderId) => void,
    /** Lazy attachment-store lookup for the `image` endpoint. */
    private readonly resolveAttachments: () => AttachmentStore | undefined,
    /** Usage lookups for providers that expose a usage endpoint. */
    private readonly usageFetchers: UsageFetchers = {},
    /**
     * Reads the Claude Code session from its own store. Constructor-injected so
     * tests can drive both login paths without a real credential store; the
     * plugin itself always uses the default.
     */
    private readonly readClaudeCreds: () => ClaudeSession | undefined = readClaudeCodeCredentials,
  ) {}

  usage(provider: ProviderId, signal: AbortSignal): Promise<ProviderUsage> {
    const fetcher = this.usageFetchers[provider]
    if (fetcher === undefined) return Promise.resolve({ supported: false })
    return fetcher(signal)
  }

  async readImage(ref: ImageAttachmentRef, signal: AbortSignal): Promise<ImageBytesResult> {
    const attachments = this.resolveAttachments()
    if (attachments === undefined) {
      throw new Error('no attachment service is mounted; generated-image bytes are unavailable')
    }
    const stored = await attachments.readImage(ref, signal)
    return { mediaType: stored.ref.mediaType, dataBase64: Buffer.from(stored.data).toString('base64') }
  }

  async readVideo(name: string, signal: AbortSignal): Promise<VideoBytesResult> {
    // The RPC layer validated `name` down to a bare file name, so this join
    // cannot escape the videos directory.
    const data = await readFile(join(videosDirectory(), name), { signal })
    return { mediaType: 'video/mp4', dataBase64: data.toString('base64') }
  }

  async status(provider: ProviderId): Promise<ProviderStatus> {
    const session = await getSession(provider)
    const account = accountOf(provider, session)
    // The plan name is shown by the usage section, so `detail` only carries errors.
    const detail = this.lastError.get(provider)
    return {
      loggedIn: session !== undefined,
      busy: this.flows.isBusy(provider) || this.deviceFlows.isBusy(provider) || this.finalizing.has(provider),
      ...session === undefined ? {} : { expiresAt: session.expiresAt },
      ...account === undefined ? {} : { account },
      ...detail === undefined ? {} : { detail },
    }
  }

  async login(provider: ProviderId): Promise<{ authorizeUrl: string; userCode?: string }> {
    if (provider === 'claude') {
      const imported = this.readClaudeCreds()
      if (imported !== undefined) {
        // An OAuth attempt may be in flight from an earlier click — the user
        // logged in through the CLI meanwhile. Claiming supersedes it whether
        // it is still waiting for its code or already exchanging one; the
        // cancel on top of that frees the listener, so `busy` clears and the
        // still-open browser tab cannot finish the flow.
        this.claim('claude')
        this.flows.pending('claude')?.cancel()
        await this.persist('claude', imported)
        this.lastError.delete('claude')
        this.onAuthChanged('claude')
        return { authorizeUrl: '' }
      }
      // No Claude Code CLI / credential store — fall back to interactive OAuth.
      const attempt = await this.flows.start('claude', claudeFlow)
      this.completions.set('claude', this.complete('claude', attempt, this.claim('claude')))
      return { authorizeUrl: attempt.authorizeUrl }
    }
    if (provider === 'copilot') {
      // Device flow: no redirect URI — the UI shows the user code while the
      // background task polls GitHub for the token.
      const attempt = await this.deviceFlows.start(provider, copilotDeviceFlow())
      this.finalizing.add(provider)
      void this.completeDevice(provider, attempt)
      return { authorizeUrl: attempt.verificationUrl, userCode: attempt.userCode }
    }
    const spec = provider === 'grok' ? await grokFlow() : codexFlow
    const attempt = await this.flows.start(provider, spec)
    // Claimed only once the attempt exists: a rejected `start()` (one attempt
    // per provider) must not supersede the attempt already running.
    this.completions.set(provider, this.complete(provider, attempt, this.claim(provider)))
    return { authorizeUrl: attempt.authorizeUrl }
  }

  /**
   * Take ownership of a provider's session, superseding every older claim.
   * @param provider - the provider route.
   * @returns the claim number a later write checks itself against.
   */
  private claim(provider: ProviderId): number {
    const next = (this.claims.get(provider) ?? 0) + 1
    this.claims.set(provider, next)
    return next
  }

  /**
   * Drive one attempt to a stored session; records failures for the status
   * endpoint. The exchange runs unsupervised — the attempt is gone from the
   * flow manager as soon as its code arrives — so the result is stored only
   * while `claim` still owns the provider's session.
   */
  private async complete(provider: ProviderId, attempt: OAuthAttempt, claim: number): Promise<void> {
    try {
      const code = await attempt.waitCode()
      const session = await this.exchange(provider, code, attempt)
      // Whoever claimed the session while the exchange ran owns it now, and
      // this result is stale. The check and the store call sit in one
      // synchronous stretch, and the store queues a write the moment it is
      // called, so a claim arriving after the check is ordered after this
      // write too.
      if (this.claims.get(provider) !== claim) return
      await this.persist(provider, session)
      this.lastError.delete(provider)
      this.onAuthChanged(provider)
    } catch (error) {
      // A failure is as stale as a success would have been: whoever claimed
      // the session while the exchange ran owns what the card shows, so a
      // superseded attempt must not put an error on a provider that has since
      // been imported, logged in again, or logged out.
      if (this.claims.get(provider) !== claim) return
      // A user-cancelled attempt is not a failure worth surfacing. Every
      // in-tree canceller claims first, so the guard above already covers
      // this; the check stands on its own so the invariant does not depend on
      // callers ordering the two.
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set(provider, errorChain(error))
      }
    }
  }

  /** Drive one device-flow attempt to a stored session (the copilot path of {@link complete}). */
  private async completeDevice(provider: ProviderId, attempt: DeviceAttempt): Promise<void> {
    try {
      const githubToken = await attempt.waitToken()
      const session = await completeCopilotLogin(githubToken)
      await this.persist(provider, session)
      this.lastError.delete(provider)
      this.onAuthChanged(provider)
    } catch (error) {
      // A user-cancelled attempt is not a failure worth surfacing.
      if (!(error instanceof Error && error.message === 'login cancelled')) {
        this.lastError.set(provider, errorChain(error))
      }
    } finally {
      this.finalizing.delete(provider)
    }
  }

  private exchange(provider: ProviderId, code: string, attempt: OAuthAttempt): Promise<StoredSession> {
    switch (provider) {
      case 'codex':
        return exchangeCodexCode(code, attempt.pkce.verifier, attempt.redirectUri)
      case 'claude':
        return exchangeClaudeCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.state)
      case 'grok':
        return exchangeGrokCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.pkce.challenge)
      case 'copilot':
        // Device flow: exchange happens in completeDevice, never here.
        return Promise.reject(new Error('copilot uses the device flow; no authorization code to exchange'))
    }
  }

  private persist(provider: ProviderId, session: StoredSession): Promise<void> {
    // The switch keeps the generic key and the session type aligned.
    switch (provider) {
      case 'codex': return saveSession('codex', session as SessionMap['codex'] & object)
      case 'claude': return saveSession('claude', session as SessionMap['claude'] & object)
      case 'grok': return saveSession('grok', session as SessionMap['grok'] & object)
      case 'copilot': return saveSession('copilot', session as SessionMap['copilot'] & object)
    }
  }

  /**
   * Settle once no OAuth completion is running for a provider.
   *
   * @internal Exported for tests only: a login's token exchange outlives the
   * `login()` call that started it, and a test asserting on what it stored
   * would otherwise have to guess at a timeout.
   */
  async settled(provider: ProviderId): Promise<void> {
    await this.completions.get(provider)
  }

  manual(provider: ProviderId, input: string): Promise<void> {
    const attempt = this.flows.pending(provider)
    if (attempt === undefined) {
      return Promise.reject(new Error(`no ${provider} login attempt is in progress`))
    }
    attempt.manual(input)
    return Promise.resolve()
  }

  cancel(provider: ProviderId): Promise<void> {
    // Claiming covers the attempt whose code already arrived: it is no longer
    // pending, but its token exchange may still be on its way to a store write.
    this.claim(provider)
    this.flows.pending(provider)?.cancel()
    this.deviceFlows.pending(provider)?.cancel()
    return Promise.resolve()
  }

  async logout(provider: ProviderId): Promise<void> {
    this.claim(provider)
    this.flows.pending(provider)?.cancel()
    this.deviceFlows.pending(provider)?.cancel()
    await deleteSession(provider)
    this.lastError.delete(provider)
    this.onAuthChanged(provider)
  }
}

export function apply(ctx: Context, config: Config): void {
  const providers = [...new Set(config.providers ?? [...PROVIDER_IDS])]
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error(`${name}: streamIdleTimeoutMs must be a positive finite number`)
  }
  const catalog = resolveCatalog(config.models)
  // A non-empty configured catalog is an explicit override: it wins over live
  // discovery entirely (schemastery injects [] for omitted arrays, so only a
  // non-empty list counts as configured).
  const overridden = new Set<ProviderId>(
    PROVIDER_IDS.filter(provider => (config.models?.[provider]?.length ?? 0) > 0),
  )
  const flows = new OAuthFlowManager()
  const deviceFlows = new DeviceFlowManager()
  const onWarn = (message: string): void => {
    ctx.logger.warn(`dsh-plugin-subscriptions: ${message}`)
  }
  // Optional: resolves ImageBlock references to bytes for vision-capable
  // models. Resolved per request — the attachments service may start after
  // this plugin's apply, so a one-time capture would stay undefined forever.
  const resolveAttachments = (): AttachmentStore | undefined =>
    ctx.get('attachments') as AttachmentStore | undefined

  // Registration handles are kept so an auth-state change can re-announce the
  // route (`replace` fires `llm/adapters-updated`), which makes the web model
  // picker re-query `listModels` and show/hide the provider.
  const handles = new Map<string, AdapterRegistrationHandle>()
  // The constructed adapters, for the pool route to fail over between.
  const adapters = new Map<ProviderId, LlmAdapter>()
  // Pool state, assigned when the pool route registers below; read here so an
  // auth change immediately recovers the provider's cooling members and
  // refreshes its quota snapshot.
  let poolHealth: PoolHealthRegistry | undefined
  let poolUsage: PoolUsageTracker | undefined
  const authChanged = (provider: ProviderId): void => {
    // Login, logout, and credential death all pass through here; a copilot
    // auth transition also drops the adapter's captured reasoning replay
    // state (isolation is already account-scoped — this is memory hygiene).
    if (provider === 'copilot') copilotAdapter?.clearReplayState()
    handles.get(provider)?.replace([provider])
    poolHealth?.clear(provider)
    poolUsage?.invalidate(provider)
    handles.get(POOL_ROUTE)?.replace([POOL_ROUTE])
  }
  // Token managers double as the tools' credential source, so they are
  // captured beside the registrations for the inject block below.
  let codexTokens: TokenManager<CodexSession> | undefined
  let claudeTokens: TokenManager<ClaudeSession> | undefined
  let grokTokens: TokenManager<GrokSession> | undefined
  // Usage lookups resolve the session through the refresh-aware path, so an
  // expired access token renews instead of failing the lookup.
  const usageFetchers: UsageFetchers = {}
  // The composer Speed toggle's state: per-session, in-memory (a restart
  // restores standard routing), gated per request on the model's discovered
  // fast-tier support so a stale choice cannot leak onto a plain model.
  const speedBySession = new Map<string, SpeedTier>()
  let codexAdapter: CodexAdapter | undefined
  // Dropped on every copilot auth transition so replay state (captured
  // reasoning) never survives an account switch in memory.
  let copilotAdapter: CopilotAdapter | undefined

  for (const provider of providers) {
    switch (provider) {
      case 'codex': {
        const tokens = new TokenManager<CodexSession>({
          displayName: 'ChatGPT (Codex)',
          preemptMs: CODEX_PREEMPT_MS,
          load: () => getSession('codex'),
          save: session => saveSession('codex', session),
          remove: () => deleteSession('codex'),
          refresh: refreshCodex,
          isPermanent: isCodexPermanentRefreshError,
          onRemoved: () => { authChanged('codex') },
        })
        codexTokens = tokens
        usageFetchers.codex = async signal => fetchCodexUsage(await tokens.session(), proxiedFetch, signal)
        let adapter!: CodexAdapter
        adapter = new CodexAdapter({
          models: catalog.codex,
          streamIdleTimeoutMs,
          tokens,
          discovery: !overridden.has('codex'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (reasoning efforts) survives
          // restarts, so a resumed session's selected effort keeps resolving.
          catalogStore: catalogStore('codex'),
          speedFor: (sessionId: string | undefined, model: string): boolean | Promise<boolean> =>
            sessionId !== undefined
            && speedBySession.get(sessionId) === 'fast'
            && adapter.supportsFastTier(model),
        })
        codexAdapter = adapter
        adapters.set('codex', adapter)
        handles.set('codex', ctx.llm.registerAdapter(['codex'], adapter))
        break
      }
      case 'claude': {
        const tokens = new TokenManager<ClaudeSession>({
          displayName: 'Claude (Subscription)',
          preemptMs: CLAUDE_PREEMPT_MS,
          load: () => getSession('claude'),
          save: session => saveSession('claude', session),
          remove: () => deleteSession('claude'),
          refresh: session => refreshClaudeSynced(session, refreshClaude),
          isPermanent: isClaudePermanentRefreshError,
          onRemoved: () => { authChanged('claude') },
        })
        claudeTokens = tokens
        usageFetchers.claude = async signal => fetchClaudeUsage(await tokens.session(), proxiedFetch, signal)
        const adapter = new ClaudeAdapter({
          models: catalog.claude,
          streamIdleTimeoutMs,
          tokens,
          discovery: !overridden.has('claude'),
          onWarn,
          maxRetries: 10,
          resolveAttachments,
          catalogStore: catalogStore('claude'),
        })
        adapters.set('claude', adapter)
        handles.set('claude', ctx.llm.registerAdapter(['claude'], adapter))
        break
      }
      case 'grok': {
        const tokens = new TokenManager<GrokSession>({
          displayName: 'Grok (Subscription)',
          preemptMs: GROK_PREEMPT_MS,
          load: () => getSession('grok'),
          save: session => saveSession('grok', session),
          remove: () => deleteSession('grok'),
          refresh: refreshGrok,
          isPermanent: isGrokPermanentRefreshError,
          onRemoved: () => { authChanged('grok') },
        })
        grokTokens = tokens
        usageFetchers.grok = async signal => fetchGrokUsage(await tokens.session(), proxiedFetch, signal)
        const adapter = new GrokAdapter({
          models: catalog.grok,
          streamIdleTimeoutMs,
          tokens,
          discovery: !overridden.has('grok'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (reasoning efforts) survives
          // restarts, so a resumed session's selected effort keeps resolving.
          catalogStore: catalogStore('grok'),
        })
        adapters.set('grok', adapter)
        handles.set('grok', ctx.llm.registerAdapter(['grok'], adapter))
        break
      }
      case 'copilot': {
        const tokens = new TokenManager<CopilotSession>({
          displayName: 'GitHub Copilot',
          preemptMs: COPILOT_PREEMPT_MS,
          load: () => getSession('copilot'),
          save: session => saveSession('copilot', session),
          remove: () => deleteSession('copilot'),
          refresh: refreshCopilot,
          isPermanent: isCopilotPermanentRefreshError,
          onRemoved: () => { authChanged('copilot') },
        })
        copilotAdapter = new CopilotAdapter({
          models: catalog.copilot,
          streamIdleTimeoutMs,
          tokens,
          discovery: !overridden.has('copilot'),
          onWarn,
          resolveAttachments,
          // Durable catalog: capability metadata (per-model vision support,
          // context windows) survives restarts and network failures.
          catalogStore: catalogStore('copilot'),
        })
        adapters.set('copilot', copilotAdapter)
        handles.set('copilot', ctx.llm.registerAdapter(['copilot'], copilotAdapter))
        break
      }
    }
  }

  // The pool route: aggregate the subscription adapters into logical models
  // (auto-discovered families + configured tiers) with cross-subscription
  // failover. Registered only when at least two providers are enabled — a
  // single adapter has nothing to pool.
  const poolConfig = config.pool
  if (poolConfig?.enabled !== false && adapters.size >= 2) {
    // Every poll gets a hard timeout: a cold usage cache AWAITS the first
    // fetch during member selection, and a hanging usage endpoint must
    // degrade the strategy (zero urgency), not stall the user's request.
    const quotaFetchers: Partial<Record<ProviderId, () => Promise<ProviderUsage>>> = {}
    if (codexTokens !== undefined) {
      const tokens = codexTokens
      quotaFetchers.codex = async () =>
        fetchCodexUsage(await tokens.session(), proxiedFetch, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS))
    }
    if (claudeTokens !== undefined) {
      const tokens = claudeTokens
      quotaFetchers.claude = async () =>
        fetchClaudeUsage(await tokens.session(), proxiedFetch, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS))
    }
    if (grokTokens !== undefined) {
      const tokens = grokTokens
      quotaFetchers.grok = async () =>
        fetchGrokUsage(await tokens.session(), proxiedFetch, AbortSignal.timeout(POOL_USAGE_TIMEOUT_MS))
    }
    poolHealth = new PoolHealthRegistry()
    poolUsage = new PoolUsageTracker(quotaFetchers)
    const families = async (): Promise<Map<string, PoolMemberRef[]>> => {
      const pools = new Map<string, PoolMemberRef[]>()
      if (poolConfig?.autoFamilies !== false) {
        // Aggregate the live catalogs (logged-out providers list nothing and
        // simply never join a pool); a discovery failure sits the round out.
        const catalogs: Partial<Record<ProviderId, readonly LlmModelInfo[]>> = {}
        await Promise.all([...adapters].map(async ([provider, adapter]) => {
          try {
            catalogs[provider] = await adapter.listModels(provider)
          } catch {
            // Discovery failures are already reported by the owning adapter.
          }
        }))
        for (const [id, members] of buildFamilyPools(catalogs)) pools.set(id, members)
      }
      for (const [id, members] of Object.entries(poolConfig?.families ?? {})) pools.set(id, members)
      return pools
    }
    handles.set(POOL_ROUTE, ctx.llm.registerAdapter([POOL_ROUTE], new PoolAdapter({
      adapters: Object.fromEntries(adapters),
      health: poolHealth,
      usage: poolUsage,
      strategy: poolConfig?.strategy ?? 'quota_aware',
      switchMargin: poolConfig?.switchMargin ?? 2,
      families,
      tiers: poolConfig?.tiers ?? {},
      onWarn,
    })))
  }

  const speed: SpeedController = {
    async speed(sessionId) {
      return {
        tier: speedBySession.get(sessionId) ?? 'standard',
        fastModels: await codexAdapter?.fastCapableModels() ?? [],
      }
    },
    async setSpeed(sessionId, tier) {
      if (tier === 'standard') speedBySession.delete(sessionId)
      else speedBySession.set(sessionId, tier)
    },
  }
  registerAuthRpc(ctx, new SubscriptionsAuthController(flows, deviceFlows, authChanged, resolveAttachments, usageFetchers), speed, {
    get: () => proxyGetConfig(),
    set: input => proxySetConfig(input),
    test: payload => proxyTestConnection(payload.url, payload.proxy),
  })

  // Proactively keep the Claude session synced with Claude Code's own store
  // (Keychain/file) every 5 minutes, so a session left idle between requests
  // does not go stale from a token rotation that happened outside this
  // plugin (the `claude` CLI refreshing on its own, or another consumer).
  if (claudeTokens !== undefined) {
    const syncTimer = setInterval(() => {
      claudeTokens?.session().catch(() => {
        // Best-effort: TokenManager already surfaces failures via onRemoved.
      })
    }, 5 * 60_000)
    ctx.effect(() => () => { clearInterval(syncTimer) }, 'dsh-plugin-subscriptions: claude background sync timer')
  }

  // `tools` is optional (headless/minimal compositions may not mount it), so
  // registration waits for the service instead of injecting it at load.
  // x_search and video_generate follow the grok provider; image_generate
  // prefers the codex provider and falls back to grok.
  ctx.inject(['tools'], (toolsCtx) => {
    if (grokTokens !== undefined) {
      toolsCtx.tools.register(createXSearchTool({ tokens: grokTokens }))
      toolsCtx.tools.register(createVideoGenerateTool({ tokens: grokTokens }))
    }
    if (codexTokens !== undefined || grokTokens !== undefined) {
      toolsCtx.tools.register(createImageGenerateTool({
        ...codexTokens === undefined ? {} : { codexTokens },
        ...grokTokens === undefined ? {} : { grokTokens },
        resolveAttachments,
        resolveLlm: () => ctx.get('llm'),
      }))
    }
  })
}
