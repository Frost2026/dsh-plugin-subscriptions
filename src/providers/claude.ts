/**
 * Claude Pro/Max subscription provider: OAuth against claude.ai /
 * platform.claude.com with the Claude Code client id, and streaming against
 * the Anthropic Messages API with the Claude Code identity headers.
 */

import { execFileSync } from 'node:child_process'
import { EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ReasoningEffortId, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { FlowSpec } from '../auth/oauth-flow.js'
import type { ClaudeSession } from '../auth/store.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveImages } from '../translate/resolved.js'
import {
  streamAnthropic,
  toAnthropicMessages,
  toAnthropicSystem,
  toAnthropicTools,
} from '../translate/anthropic.js'
import {
  httpLlmError,
  idleWatchdog,
  mapFetchFailure,
  oauthEndpointError,
  OAuthEndpointError,
  TokenManager,
} from './common.js'
import type { DiscoveredModel, FetchFn, ModelEntry, ProviderUsage, UsageWindow } from './common.js'

export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const CLAUDE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize'
export const CLAUDE_TOKEN_URL = 'https://claude.ai/v1/oauth/token'
export const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages?beta=true'
export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
export const CLAUDE_MODELS_URL = 'https://api.anthropic.com/v1/models?beta=true'
const CLAUDE_SCOPE = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
const CLAUDE_CALLBACK_PATH = '/callback'
const CLAUDE_CONTEXT_WINDOW = 200_000
const CLAUDE_DEFAULT_MAX_TOKENS = 32_000
/** Refresh when the access token has less than this much life left. */
export const CLAUDE_PREEMPT_MS = 5 * 60_000

/**
 * The subscription endpoint only serves requests presenting as Claude Code,
 * so these headers impersonate the CLI; the harness attribution user-agent
 * cannot be sent here (one user-agent slot, and the CLI's wins).
 */
export const CLAUDE_CLI_FALLBACK_VERSION = '2.1.234'

export function detectClaudeVersion(): string {
  try {
    const raw = execFileSync('claude', ['--version'], { timeout: 3000, encoding: 'utf8' })
    const match = raw.match(/^(\d+\.\d+\.\d+)/)
    if (match) return match[1]
  } catch {}
  return CLAUDE_CLI_FALLBACK_VERSION
}

const CLAUDE_CLI_USER_AGENT = `claude-cli/${detectClaudeVersion()} (external, cli)`
export const CLAUDE_BETA_FALLBACK = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'effort-2025-11-24',
  'compact-2026-01-12',
  'files-api-2025-04-14',
].join(',')

export function detectBetaFlags(): string {
  try {
    const raw = execFileSync('claude', ['--betas'], { timeout: 3000, encoding: 'utf8' })
    const flags = raw.trim().split(/[\s,]+/).filter(f => /^[a-z][\w-]+-\d{4}-\d{2}-\d{2}$/.test(f))
    if (flags.length > 0) return flags.join(',')
  } catch {}
  return CLAUDE_BETA_FALLBACK
}

const CLAUDE_BETA_FLAGS = detectBetaFlags()

/** Static claude flow facts for the OAuth flow engine. */
export const claudeFlow: FlowSpec = {
  callbackPath: CLAUDE_CALLBACK_PATH,
  // The redirect URI embeds the port, so it must be an ephemeral one.
  listen: { host: '127.0.0.1', ports: [0] },
  buildAuthorizeUrl({ redirectUri, state, pkce }) {
    const params = new URLSearchParams({
      code: 'true',
      client_id: CLAUDE_CLIENT_ID,
      response_type: 'code',
      redirect_uri: 'https://platform.claude.com/oauth/code/callback',
      scope: CLAUDE_SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
    })
    return `${CLAUDE_AUTHORIZE_URL}?${params.toString()}`
  },
}

/** Token endpoint response shape (subset). */
interface ClaudeTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

/** Best-effort account profile; login must not fail when this does. */
async function fetchClaudeProfile(accessToken: string): Promise<Pick<ClaudeSession, 'emailAddress' | 'subscriptionType'>> {
  try {
    const response = await fetch(CLAUDE_PROFILE_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) return {}
    const profile = await response.json() as Record<string, unknown>
    const account = typeof profile.account === 'object' && profile.account !== null
      ? profile.account as Record<string, unknown>
      : {}
    const email = profile.emailAddress ?? profile.email ?? account.email_address ?? account.email
    const subscription = profile.subscriptionType ?? profile.subscription_type ?? account.subscription_type
    return {
      ...typeof email === 'string' && email.length > 0 ? { emailAddress: email } : {},
      ...typeof subscription === 'string' && subscription.length > 0 ? { subscriptionType: subscription } : {},
    }
  } catch {
    // Profile lookup is decorative; only the token exchange owns login success.
    return {}
  }
}

/** Build a session from a token response. */
async function claudeSession(
  tokens: ClaudeTokenResponse,
  fallbackRefreshToken: string | undefined,
  withProfile: boolean,
): Promise<ClaudeSession> {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new Error('claude token endpoint returned no access token')
  }
  const refreshToken = tokens.refresh_token ?? fallbackRefreshToken
  if (refreshToken === undefined) throw new Error('claude token endpoint returned no refresh token')
  if (typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0) {
    throw new Error('claude token endpoint returned no usable expiry')
  }
  const profile = withProfile ? await fetchClaudeProfile(tokens.access_token) : {}
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scopes: tokens.scope ?? CLAUDE_SCOPE,
    ...profile,
  }
}

/**
 * Exchange an authorization code for a claude session (JSON grant).
 * @param code - the authorization code from the callback.
 * @param verifier - the PKCE verifier minted for the attempt.
 * @param redirectUri - the attempt's redirect URI.
 * @param state - the attempt's state (echoed to the token endpoint).
 * @returns the session to store.
 */
export async function exchangeClaudeCode(
  code: string,
  verifier: string,
  redirectUri: string,
  state: string,
): Promise<ClaudeSession> {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: verifier,
      state,
    }),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'claude')
  return claudeSession(await response.json() as ClaudeTokenResponse, undefined, true)
}

/**
 * Refresh a claude session (JSON grant echoing the issued scope).
 * @param session - the stored session.
 * @returns the fresh session to store.
 */
export async function refreshClaude(session: ClaudeSession): Promise<ClaudeSession> {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
      scope: session.scopes,
    }),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'claude')
  const next = await claudeSession(await response.json() as ClaudeTokenResponse, session.refreshToken, false)
  return {
    ...next,
    ...session.emailAddress === undefined ? {} : { emailAddress: session.emailAddress },
    ...session.subscriptionType === undefined ? {} : { subscriptionType: session.subscriptionType },
  }
}

/**
 * Whether a claude refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export function isClaudePermanentRefreshError(error: unknown): boolean {
  return error instanceof OAuthEndpointError
    && (error.oauthCode === 'invalid_grant' || error.oauthCode === 'invalid_token')
}

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** RFC3339 `resets_at` value → epoch ms, or undefined when absent/unparsable. */
function claudeResetsAt(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Map one legacy `{utilization, resets_at}` bucket; undefined when null or unusable. */
function claudeLegacyWindow(value: unknown, kind: UsageWindow['kind'], scope?: string): UsageWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const bucket = value as { utilization?: number; resets_at?: string }
  if (typeof bucket.utilization !== 'number' || !Number.isFinite(bucket.utilization)) return undefined
  const resetsAt = claudeResetsAt(bucket.resets_at)
  return {
    kind,
    ...scope === undefined ? {} : { scope },
    usedPercent: bucket.utilization,
    ...resetsAt === undefined ? {} : { resetsAt },
  }
}

/** One entry of the modern `limits` array (subset). */
interface ClaudeLimitEntry {
  kind?: string
  percent?: number
  resets_at?: string
  scope?: { model?: { display_name?: string } }
}

/** Map the modern `limits` array; empty when absent or carrying nothing usable. */
function claudeLimitsWindows(value: unknown): UsageWindow[] {
  if (!Array.isArray(value)) return []
  const windows: UsageWindow[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as ClaudeLimitEntry
    if (typeof entry.percent !== 'number' || !Number.isFinite(entry.percent)) continue
    const kind: UsageWindow['kind'] = entry.kind === 'session'
      ? 'session'
      : entry.kind === 'weekly_all' || entry.kind === 'weekly_scoped' ? 'weekly' : 'other'
    const scope = entry.scope?.model?.display_name
    const resetsAt = claudeResetsAt(entry.resets_at)
    windows.push({
      kind,
      ...typeof scope === 'string' && scope.length > 0 ? { scope } : {},
      usedPercent: entry.percent,
      ...resetsAt === undefined ? {} : { resetsAt },
    })
  }
  return windows
}

/**
 * Fetch the claude subscription usage from the OAuth usage endpoint (the
 * source of Claude Code's `/usage` screen). Newer responses carry a
 * structured `limits` array; older ones the flat `five_hour`/`seven_day*`
 * buckets — both shapes are read, the array winning when it has entries.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @param signal - caller cancellation from the RPC transport.
 * @returns the mapped usage snapshot.
 */
export async function fetchClaudeUsage(
  session: ClaudeSession,
  fetchFn: FetchFn = fetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const response = await fetchFn(CLAUDE_USAGE_URL, {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      // Unrecognized clients are aggressively rate-limited on this endpoint,
      // so it presents as the CLI like every other subscription request.
      'user-agent': CLAUDE_CLI_USER_AGENT,
      'accept': 'application/json',
    },
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'claude usage')
  const payload = await response.json() as Record<string, unknown>
  const modern = claudeLimitsWindows(payload.limits)
  if (modern.length > 0) return { supported: true, windows: modern }
  const windows: UsageWindow[] = []
  const legacy = [
    claudeLegacyWindow(payload.five_hour, 'session'),
    claudeLegacyWindow(payload.seven_day, 'weekly'),
    claudeLegacyWindow(payload.seven_day_opus, 'weekly', 'Opus'),
    claudeLegacyWindow(payload.seven_day_sonnet, 'weekly', 'Sonnet'),
  ]
  for (const window of legacy) {
    if (window !== undefined) windows.push(window)
  }
  return { supported: true, windows }
}

/** A discovered model plus which extended-thinking wire shape it accepts, when any. */
export interface ClaudeDiscoveredModel extends ModelEntry {
  /**
   * `enabled` models (Claude 4.5 generation) accept `thinking: {type:'enabled',
   * budget_tokens}` and return a readable thinking summary. `adaptive` models
   * (4.6+/5 generation) accept `thinking: {type:'adaptive'}` and think for
   * real (billed `thinking_tokens`) but Anthropic returns no readable summary
   * text for that mode — only an opaque replay signature; effort control
   * (below) is how much of that invisible budget is spent.
   */
  thinkingType?: 'enabled' | 'adaptive'
  /** Advertised effort levels, when the model accepts the `output_config.effort` field. */
  reasoning?: DiscoveredModel['reasoning']
}

interface ClaudeModelCapabilities {
  thinking?: {
    types?: {
      enabled?: { supported?: boolean }
      adaptive?: { supported?: boolean }
    }
  }
  effort?: {
    supported?: boolean
    low?: { supported?: boolean }
    medium?: { supported?: boolean }
    high?: { supported?: boolean }
    xhigh?: { supported?: boolean }
    max?: { supported?: boolean }
  }
}

function claudeThinkingType(capabilities: ClaudeModelCapabilities | undefined): 'enabled' | 'adaptive' | undefined {
  const types = capabilities?.thinking?.types
  if (types?.enabled?.supported === true) return 'enabled'
  if (types?.adaptive?.supported === true) return 'adaptive'
  return undefined
}

/** Effort levels in display order; a model exposes only the ones it advertises as supported. */
const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function claudeReasoning(capabilities: ClaudeModelCapabilities | undefined): DiscoveredModel['reasoning'] {
  const effort = capabilities?.effort
  if (effort?.supported !== true) return undefined
  const efforts = CLAUDE_EFFORT_LEVELS
    .filter(level => effort[level]?.supported === true)
    .map(level => ({ id: ReasoningEffortId(level), name: level[0].toUpperCase() + level.slice(1) }))
  return efforts.length > 0 ? { efforts } : undefined
}

/** Fetch the live model catalog from the subscription endpoint. */
export async function fetchClaudeModels(
  session: ClaudeSession,
  fetchFn: FetchFn = fetch,
): Promise<ClaudeDiscoveredModel[]> {
  const response = await fetchFn(CLAUDE_MODELS_URL, {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      'anthropic-version': '2023-06-01',
      'user-agent': CLAUDE_CLI_USER_AGENT,
      'anthropic-dangerous-direct-browser-access': 'true',
      'accept': 'application/json',
    },
  })
  if (!response.ok) return []
  const payload = await response.json() as {
    data?: Array<{ id?: string; display_name?: string; capabilities?: ClaudeModelCapabilities }>
  }
  if (!Array.isArray(payload.data)) return []
  return payload.data
    .filter((m): m is { id: string; display_name?: string; capabilities?: ClaudeModelCapabilities } => typeof m.id === 'string')
    .map((m) => {
      const thinkingType = claudeThinkingType(m.capabilities)
      const reasoning = claudeReasoning(m.capabilities)
      return {
        id: m.id,
        name: m.display_name ?? m.id,
        ...m.id.includes('opus') ? { maxTokens: 64_000 } : {},
        ...thinkingType === undefined ? {} : { thinkingType },
        ...reasoning === undefined ? {} : { reasoning },
      }
    })
}

/** Constructor dependencies for {@link ClaudeAdapter}. */
export interface ClaudeAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: TokenManager<ClaudeSession>
  discovery?: boolean
  fetchFn?: FetchFn
  onWarn?: (message: string) => void
  /** Max retries on a retryable failure before giving up; matches Claude Code's own client-side retry count. Defaults to the dsh-llm default (2) when unset. */
  maxRetries?: number
  /** Resolve the attachment service per request; absent means image requests fail loudly. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/**
 * Claude Code's own SDK retry shape: exponential backoff starting at 1s,
 * doubling per attempt, capped at 60s, plus jitter. `maxRetries` is the
 * count of retries after the first attempt (Claude Code defaults to 10).
 */
const CLAUDE_RETRY_INITIAL_DELAY_MS = 1_000
const CLAUDE_RETRY_MAX_DELAY_MS = 60_000
const CLAUDE_RETRY_JITTER_RATIO = 0.2

/** The Claude 4.5 family accepts image input. */
const CLAUDE_MODALITIES: readonly ('text' | 'image')[] = ['text', 'image']

/** Claude wire adapter: one instance serves the `claude` provider route. */
export class ClaudeAdapter extends LlmAdapter {
  /** Per-model extended-thinking wire shape, learned from the last successful discovery. */
  private thinkingTypes = new Map<string, 'enabled' | 'adaptive'>()
  /** Per-model advertised effort levels, learned from the last successful discovery. */
  private reasoningByModel = new Map<string, DiscoveredModel['reasoning']>()

  constructor(private readonly options: ClaudeAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Claude (Subscription)' }
  }

  override providerRetryPolicy(provider: string) {
    if (this.options.maxRetries === undefined) return undefined
    return resolveRetryPolicy({
      mode: 'normal',
      maxRetries: this.options.maxRetries,
      backoff: {
        initialDelayMs: CLAUDE_RETRY_INITIAL_DELAY_MS,
        maxDelayMs: CLAUDE_RETRY_MAX_DELAY_MS,
        jitterRatio: CLAUDE_RETRY_JITTER_RATIO,
      },
    }, `claude: provider "${provider}" retryPolicy`)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (!await this.options.tokens.hasSession()) return []
    if (this.options.discovery !== false) {
      try {
        const session = await this.options.tokens.session()
        const discovered = await fetchClaudeModels(session, this.options.fetchFn)
        if (discovered.length > 0) {
          this.thinkingTypes.clear()
          this.reasoningByModel.clear()
          for (const model of discovered) {
            if (model.thinkingType !== undefined) this.thinkingTypes.set(model.id, model.thinkingType)
            if (model.reasoning !== undefined) this.reasoningByModel.set(model.id, model.reasoning)
          }
          return discovered.map(model => ({
            provider,
            id: model.id,
            name: model.name ?? model.id,
            inputModalities: model.inputModalities ?? CLAUDE_MODALITIES,
          }))
        }
        this.options.onWarn?.('claude model discovery returned empty catalog; using static fallback')
      } catch {
        this.options.onWarn?.('claude model discovery failed; using static fallback')
      }
    }
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: model.inputModalities ?? CLAUDE_MODALITIES,
    }))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const configured = this.options.models.find(entry => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: configured?.name ?? model,
      inputModalities: configured?.inputModalities ?? CLAUDE_MODALITIES,
      context: { contextWindow: configured?.contextWindow ?? CLAUDE_CONTEXT_WINDOW },
      defaultMaxTokens: configured?.maxTokens ?? CLAUDE_DEFAULT_MAX_TOKENS,
      // Efforts come from the discovered catalog (capabilities.effort); models
      // it does not cover expose none, so the harness rejects explicit efforts
      // before provider I/O instead of the API 400ing.
      ...this.reasoningByModel.get(model) === undefined ? {} : { reasoning: this.reasoningByModel.get(model) },
    })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      let session = await this.options.tokens.session()
      let response = await this.request(options, session, watchdog.signal)
      if (response.status === 401) {
        // One forced refresh + retry on an unexpired-but-rejected token.
        session = await this.options.tokens.session(true)
        response = await this.request(options, session, watchdog.signal)
      }
      if (!response.ok) throw await httpLlmError(response, 'claude API')
      if (response.body === null) {
        throw new LlmError('claude API returned no response body', EMPTY_RESPONSE_CODE)
      }
      yield* streamAnthropic(response.body, () => { watchdog.pulse() })
    } catch (error: unknown) {
      throw mapFetchFailure('claude API', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  /**
   * The `thinking` request param for one model, or undefined when the model
   * advertised no extended-thinking support (or discovery has not run yet).
   * `enabled`-type models need `budget_tokens < max_tokens`; below that floor
   * thinking is skipped rather than sent with an invalid budget.
   */
  private thinkingParam(model: string, maxTokens: number): Record<string, unknown> | undefined {
    const type = this.thinkingTypes.get(model)
    if (type === 'adaptive') return { type: 'adaptive' }
    if (type === 'enabled') {
      const budget = Math.min(Math.max(1_024, Math.floor(maxTokens * 0.5)), maxTokens - 100)
      if (budget < 1_024) return undefined
      return { type: 'enabled', budget_tokens: budget }
    }
    return undefined
  }

  private async request(options: GenerateOptions, session: ClaudeSession, signal: AbortSignal): Promise<Response> {
    const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal)
    const maxTokens = options.maxTokens
      ?? this.options.models.find(entry => entry.id === options.model)?.maxTokens
      ?? CLAUDE_DEFAULT_MAX_TOKENS
    const thinking = this.thinkingParam(options.model, maxTokens)
    // The harness only passes an effort the resolved model advertised (the
    // discovered catalog's), so this never reaches a model that rejects it.
    // Wire location confirmed empirically: a top-level `effort` field 400s
    // ("Extra inputs are not permitted"); Anthropic accepts it only nested
    // under `output_config`.
    const effort = options.reasoningEffort !== undefined && this.reasoningByModel.has(options.model)
      ? { output_config: { effort: String(options.reasoningEffort) } }
      : {}
    const body = {
      model: options.model,
      max_tokens: maxTokens,
      system: toAnthropicSystem(options.system, messages),
      messages: toAnthropicMessages(messages),
      ...options.tools !== undefined && options.tools.length > 0
        ? { tools: toAnthropicTools(options.tools) }
        : {},
      ...thinking === undefined ? {} : { thinking },
      ...effort,
      stream: true,
      ...options.sessionId !== undefined ? { metadata: { user_id: String(options.sessionId) } } : {},
    }
    return fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${session.accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': CLAUDE_BETA_FLAGS,
        'user-agent': CLAUDE_CLI_USER_AGENT,
        'x-app': 'cli',
        'anthropic-dangerous-direct-browser-access': 'true',
        'accept': 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
  }
}
