/**
 * Google Antigravity subscription provider. This is intentionally separate
 * from Gemini CLI: it uses Antigravity OAuth scopes, project discovery, and
 * the daily-cloudcode-pa v1internal request envelope.
 */

import { errorChain, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { FlowSpec } from '../auth/oauth-flow.js'
import type { AntigravitySession } from '../auth/store.js'
import { resolveImages } from '../translate/resolved.js'
import {
  parseAntigravityResponse,
  streamAntigravity,
  toAntigravityRequest,
} from '../translate/antigravity.js'
import type { AntigravityRequest, AntigravityResponseEvent } from '../translate/antigravity.js'
import {
  httpLlmError,
  idleWatchdog,
  mapFetchFailure,
  ModelCatalogCache,
  discoverOrRetryAuth,
  isMissingOrInvalidCredential,
  oauthEndpointError,
  OAuthEndpointError,
  TokenManager,
} from './common.js'
import type {
  CatalogPersistence,
  DiscoveredModel,
  FetchFn,
  ModelEntry,
  ProviderUsage,
  UsageWindow,
} from './common.js'

export const ANTIGRAVITY_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const ANTIGRAVITY_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
export const ANTIGRAVITY_DEFAULT_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com'
export const ANTIGRAVITY_PROD_BASE_URL = 'https://cloudcode-pa.googleapis.com'
export const ANTIGRAVITY_DEFAULT_USER_AGENT = 'antigravity/1.104.0 dsh-plugin-subscriptions'
export const ANTIGRAVITY_PREEMPT_MS = 5 * 60_000
const ANTIGRAVITY_CALLBACK_PATH = '/oauth-callback'
const ANTIGRAVITY_CONTEXT_WINDOW = 1_024_000
const ANTIGRAVITY_DEFAULT_MAX_TOKENS = 65_536

/** Antigravity, not Gemini CLI, OAuth scopes from the local reference clients. */
export const ANTIGRAVITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const

/** OAuth client configuration. Values must come from config/environment. */
export interface AntigravityOAuthConfig {
  clientId: string
  clientSecret?: string
}

/** Runtime endpoint configuration. */
export interface AntigravityRuntimeConfig {
  baseURL?: string
  userAgent?: string
  /** Activate an eligible account when loadCodeAssist has no project yet. */
  onboard?: boolean
}

/** Resolve and validate a user-supplied OAuth config without embedded credentials. */
export function resolveAntigravityOAuthConfig(config?: Partial<AntigravityOAuthConfig>): AntigravityOAuthConfig {
  const clientId = config?.clientId?.trim() || process.env.ANTIGRAVITY_CLIENT_ID?.trim() || ''
  const clientSecret = config?.clientSecret?.trim() || process.env.ANTIGRAVITY_CLIENT_SECRET?.trim()
  if (clientId.length === 0) {
    throw new Error(
      'Antigravity OAuth is not configured; set config.antigravity.clientId or ANTIGRAVITY_CLIENT_ID '
      + '(and clientSecret/ANTIGRAVITY_CLIENT_SECRET when required by the Google OAuth client)',
    )
  }
  return { clientId, ...clientSecret === undefined || clientSecret.length === 0 ? {} : { clientSecret } }
}

/** Normalize the configured API origin and reject paths/credentials. */
export function antigravityBaseURL(value?: string): string {
  const parsed = new URL(value?.trim() || ANTIGRAVITY_DEFAULT_BASE_URL)
  if (parsed.protocol !== 'https:' || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error('config.antigravity.baseURL must be an HTTPS origin without credentials')
  }
  if (parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error('config.antigravity.baseURL must not contain a path, query, or fragment')
  }
  return parsed.origin
}

/** Google authorization-code + PKCE flow for Antigravity. */
export function antigravityFlow(oauth: AntigravityOAuthConfig): FlowSpec {
  return {
    callbackPath: ANTIGRAVITY_CALLBACK_PATH,
    listen: { host: 'localhost', ports: [51121, 0] },
    timeoutMs: 5 * 60_000,
    buildAuthorizeUrl({ redirectUri, state, pkce }) {
      const params = new URLSearchParams({
        access_type: 'offline',
        client_id: oauth.clientId,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        include_granted_scopes: 'true',
        prompt: 'consent',
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: ANTIGRAVITY_SCOPES.join(' '),
        state,
      })
      return `${ANTIGRAVITY_AUTHORIZE_URL}?${params.toString()}`
    },
  }
}

interface GoogleTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

interface AntigravityAccountInfo {
  projectId: string
  account?: string
  plan?: string
}

/** Shared Antigravity API headers. */
export function antigravityHeaders(accessToken: string, userAgent = ANTIGRAVITY_DEFAULT_USER_AGENT): Record<string, string> {
  return {
    'authorization': `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': userAgent,
  }
}

/** POST a v1internal JSON method and classify non-2xx responses. */
async function callInternal<T>(
  method: string,
  body: unknown,
  accessToken: string,
  runtime: AntigravityRuntimeConfig,
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetchFn(`${antigravityBaseURL(runtime.baseURL)}/v1internal:${method}`, {
    method: 'POST',
    headers: antigravityHeaders(accessToken, runtime.userAgent),
    body: JSON.stringify(body),
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await httpLlmError(response, `Antigravity ${method}`)
  return response.json() as Promise<T>
}

function projectIdOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'object' && value !== null) {
    const id = (value as Record<string, unknown>).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: unknown
  currentTier?: { id?: string; name?: string }
  paidTier?: { id?: string; name?: string; availableCredits?: { creditAmount?: number | string }[] }
  allowedTiers?: { id?: string; isDefault?: boolean }[]
  manageSubscriptionUri?: string
}

/** Read (and, when enabled, initialize) the Antigravity project/account. */
export async function discoverAntigravityAccount(
  accessToken: string,
  runtime: AntigravityRuntimeConfig = {},
  fetchFn: FetchFn = fetch,
): Promise<AntigravityAccountInfo> {
  const metadata = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
  const load = await callInternal<LoadCodeAssistResponse>('loadCodeAssist', { metadata }, accessToken, runtime, fetchFn)
  let projectId = projectIdOf(load.cloudaicompanionProject)
  if (projectId === undefined && runtime.onboard !== false) {
    const tierId = load.allowedTiers?.find(tier => tier.isDefault)?.id ?? 'LEGACY'
    const onboardBody = { tierId, metadata }
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await callInternal<{
        done?: boolean
        response?: { cloudaicompanionProject?: unknown }
      }>('onboardUser', onboardBody, accessToken, runtime, fetchFn)
      if (result.done === true) {
        projectId = projectIdOf(result.response?.cloudaicompanionProject)
        break
      }
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
  }
  if (projectId === undefined) {
    throw new Error('Antigravity account has no Cloud AI Companion project; open Antigravity and complete onboarding, then log in again')
  }

  let account: string | undefined
  try {
    const profileResponse = await fetchFn(ANTIGRAVITY_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    })
    if (profileResponse.ok) {
      const profile = await profileResponse.json() as { email?: string }
      if (typeof profile.email === 'string' && profile.email.length > 0) account = profile.email
    }
  } catch {
    // Identity is display-only; project discovery is the login boundary.
  }
  const plan = load.paidTier?.name ?? load.paidTier?.id ?? load.currentTier?.name ?? load.currentTier?.id
  return {
    projectId,
    ...account === undefined ? {} : { account },
    ...typeof plan !== 'string' || plan.length === 0 ? {} : { plan },
  }
}

function sessionFromTokens(tokens: GoogleTokenResponse, account: AntigravityAccountInfo, fallback?: AntigravitySession): AntigravitySession {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new Error('Antigravity token endpoint returned no access token')
  }
  const refreshToken = tokens.refresh_token ?? fallback?.refreshToken
  if (refreshToken === undefined || refreshToken.length === 0) {
    throw new Error('Antigravity token endpoint returned no refresh token; revoke the app grant and log in again')
  }
  if (typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0) {
    throw new Error('Antigravity token endpoint returned no usable expiry')
  }
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    projectId: account.projectId,
    ...tokens.scope === undefined ? {} : { scopes: tokens.scope },
    ...account.account === undefined ? {} : { account: account.account },
    ...account.plan === undefined ? {} : { plan: account.plan },
  }
}

/** Exchange a Google OAuth authorization code and discover the Antigravity project. */
export async function exchangeAntigravityCode(
  code: string,
  verifier: string,
  redirectUri: string,
  oauth: AntigravityOAuthConfig,
  runtime: AntigravityRuntimeConfig = {},
  fetchFn: FetchFn = fetch,
): Promise<AntigravitySession> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: oauth.clientId,
    code_verifier: verifier,
    ...oauth.clientSecret === undefined ? {} : { client_secret: oauth.clientSecret },
  })
  const response = await fetchFn(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'Antigravity')
  const tokens = await response.json() as GoogleTokenResponse
  if (typeof tokens.access_token !== 'string') throw new Error('Antigravity token endpoint returned no access token')
  const account = await discoverAntigravityAccount(tokens.access_token, runtime, fetchFn)
  return sessionFromTokens(tokens, account)
}

/** Refresh a stored Antigravity Google token, preserving project/account metadata. */
export async function refreshAntigravity(
  session: AntigravitySession,
  oauth: AntigravityOAuthConfig,
  fetchFn: FetchFn = fetch,
): Promise<AntigravitySession> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    client_id: oauth.clientId,
    ...oauth.clientSecret === undefined ? {} : { client_secret: oauth.clientSecret },
  })
  const response = await fetchFn(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'Antigravity')
  return sessionFromTokens(await response.json() as GoogleTokenResponse, {
    projectId: session.projectId,
    ...session.account === undefined ? {} : { account: session.account },
    ...session.plan === undefined ? {} : { plan: session.plan },
  }, session)
}

/** Refresh failures that require a fresh Google consent grant. */
export function isAntigravityPermanentRefreshError(error: unknown): boolean {
  return error instanceof OAuthEndpointError
    && (error.status === 400 || error.status === 401 || error.status === 403)
    && (error.oauthCode === 'invalid_grant' || error.status !== 400)
}

interface AntigravityWireModel {
  displayName?: string
  description?: string
  inputTokenLimit?: number
  maxInputTokens?: number
  quotaInfo?: { remainingFraction?: number; resetTime?: string }
  weeklyQuotaInfo?: { remainingFraction?: number; resetTime?: string }
  weeklyQuota?: { remainingFraction?: number; resetTime?: string }
}

interface AntigravityModelsResponse {
  models?: Record<string, AntigravityWireModel>
}

/** Fetch the authenticated account's live Antigravity model catalog. */
export async function fetchAntigravityModels(
  session: AntigravitySession,
  runtime: AntigravityRuntimeConfig = {},
  fetchFn: FetchFn = fetch,
): Promise<DiscoveredModel[]> {
  const payload = await callInternal<AntigravityModelsResponse>(
    'fetchAvailableModels',
    { project: session.projectId },
    session.accessToken,
    runtime,
    fetchFn,
  )
  if (typeof payload.models !== 'object' || payload.models === null) {
    throw new Error('Antigravity models endpoint returned no models object')
  }
  const models = Object.entries(payload.models).map(([id, model]): DiscoveredModel => ({
    id,
    name: model.displayName ?? id.split('-').map(word => word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)).join(' '),
    ...model.description === undefined ? {} : { description: model.description },
    contextWindow: model.inputTokenLimit ?? model.maxInputTokens ?? ANTIGRAVITY_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
  }))
  if (models.length === 0) throw new Error('Antigravity models endpoint returned an empty catalog')
  return models
}

function resetTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function usageWindow(
  kind: UsageWindow['kind'],
  scope: string,
  quota: { remainingFraction?: number; resetTime?: string } | undefined,
): UsageWindow | undefined {
  const remaining = quota?.remainingFraction
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return undefined
  const resetsAt = resetTime(quota?.resetTime)
  return {
    kind,
    scope,
    usedPercent: Math.max(0, Math.min(100, (1 - remaining) * 100)),
    ...resetsAt === undefined ? {} : { resetsAt },
  }
}

/** Fetch plan and per-model quota windows when the upstream exposes them. */
export async function fetchAntigravityUsage(
  session: AntigravitySession,
  runtime: AntigravityRuntimeConfig = {},
  fetchFn: FetchFn = fetch,
  signal?: AbortSignal,
): Promise<ProviderUsage> {
  const metadata = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }
  const [models, account] = await Promise.all([
    callInternal<AntigravityModelsResponse>(
      'fetchAvailableModels', { project: session.projectId }, session.accessToken, runtime, fetchFn, signal,
    ),
    callInternal<LoadCodeAssistResponse>('loadCodeAssist', { metadata }, session.accessToken, runtime, fetchFn, signal),
  ])
  const windows: UsageWindow[] = []
  for (const [modelId, model] of Object.entries(models.models ?? {})) {
    const ordinary = usageWindow('other', modelId, model.quotaInfo)
    const weekly = usageWindow('weekly', modelId, model.weeklyQuotaInfo ?? model.weeklyQuota)
    if (ordinary !== undefined) windows.push(ordinary)
    if (weekly !== undefined) windows.push(weekly)
  }
  const plan = account.paidTier?.name ?? account.paidTier?.id
    ?? account.currentTier?.name ?? account.currentTier?.id ?? session.plan
  const credits = account.paidTier?.availableCredits?.[0]?.creditAmount
  const displayPlan = credits === undefined ? plan : `${plan ?? 'Antigravity'} · ${String(credits)} credits`
  return {
    supported: true,
    windows,
    ...displayPlan === undefined ? {} : { plan: displayPlan },
  }
}

/** URL for either v1internal generation transport. */
export function antigravityGenerateURL(baseURL: string | undefined, stream: boolean): string {
  return `${antigravityBaseURL(baseURL)}/v1internal:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
}

/** Forward one already-built payload to generateContent or streamGenerateContent. */
export async function requestAntigravityContent(
  session: AntigravitySession,
  payload: AntigravityRequest,
  stream: boolean,
  runtime: AntigravityRuntimeConfig = {},
  fetchFn: FetchFn = fetch,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchFn(antigravityGenerateURL(runtime.baseURL, stream), {
    method: 'POST',
    headers: {
      ...antigravityHeaders(session.accessToken, runtime.userAgent),
      accept: stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify(payload),
    ...signal === undefined ? {} : { signal },
  })
}

export interface AntigravityAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: TokenManager<AntigravitySession>
  discovery: boolean
  runtime?: AntigravityRuntimeConfig
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  resolveAttachments?: () => AttachmentStore | undefined
  catalogStore?: CatalogPersistence
}

/** DSH provider adapter for the `antigravity` route. */
export class AntigravityAdapter extends LlmAdapter {
  private readonly catalog: ModelCatalogCache

  constructor(private readonly options: AntigravityAdapterOptions) {
    super()
    this.catalog = new ModelCatalogCache(options.catalogStore)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Google Antigravity' }
  }

  private staticModels(provider: string): LlmModelInfo[] {
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: model.inputModalities ?? ['text', 'image'],
    }))
  }

  private fetchCatalog(): Promise<DiscoveredModel[]> {
    return this.options.tokens.session().then(session => fetchAntigravityModels(
      session, this.options.runtime, this.options.fetchFn,
    ))
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (await this.options.tokens.peek() === undefined) return []
    if (!this.options.discovery) return this.staticModels(provider)
    try {
      const models = await discoverOrRetryAuth(
        force => this.options.tokens.session(force),
        this.catalog,
        () => this.catalog.get(() => this.fetchCatalog()),
      )
      return models.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        inputModalities: model.inputModalities ?? ['text', 'image'],
      }))
    } catch (error) {
      if (isMissingOrInvalidCredential(error)) return []
      this.options.onWarn?.(`Antigravity model discovery failed; using the built-in catalog (${errorChain(error)})`)
      return this.staticModels(provider)
    }
  }

  private async discovered(model: string): Promise<DiscoveredModel | undefined> {
    if (!this.options.discovery) return undefined
    const models = await this.catalog.resolve(() => this.fetchCatalog())
    return models?.find(entry => entry.id === model)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const discovered = await this.discovered(model)
    const configured = this.options.models.find(entry => entry.id === model)
    return {
      provider,
      id: model,
      name: discovered?.name ?? configured?.name ?? model,
      ...discovered?.description === undefined ? {} : { description: discovered.description },
      inputModalities: discovered?.inputModalities ?? configured?.inputModalities ?? ['text', 'image'],
      context: { contextWindow: discovered?.contextWindow ?? configured?.contextWindow ?? ANTIGRAVITY_CONTEXT_WINDOW },
      defaultMaxTokens: configured?.maxTokens ?? ANTIGRAVITY_DEFAULT_MAX_TOKENS,
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      let session = await this.options.tokens.session()
      const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), watchdog.signal)
      const payload = toAntigravityRequest(options, messages, session.projectId)
      let response = await requestAntigravityContent(
        session, payload, true, this.options.runtime, this.options.fetchFn, watchdog.signal,
      )
      if (response.status === 401) {
        this.catalog.invalidate()
        session = await this.options.tokens.session(true)
        response = await requestAntigravityContent(
          session, payload, true, this.options.runtime, this.options.fetchFn, watchdog.signal,
        )
      }
      if (!response.ok) throw await httpLlmError(response, 'Antigravity API')
      if (response.body === null) {
        throw new LlmError('Antigravity API returned no response body', EMPTY_RESPONSE_CODE)
      }
      yield* streamAntigravity(response.body, () => { watchdog.pulse() })
    } catch (error) {
      throw mapFetchFailure('Antigravity API', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  /** Non-stream forwarding seam used by tests and future DSH complete calls. */
  async generate(options: GenerateOptions): Promise<StreamChunk[]> {
    const session = await this.options.tokens.session()
    const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), options.signal)
    const response = await requestAntigravityContent(
      session,
      toAntigravityRequest(options, messages, session.projectId),
      false,
      this.options.runtime,
      this.options.fetchFn,
      options.signal,
    )
    if (!response.ok) throw await httpLlmError(response, 'Antigravity API')
    return parseAntigravityResponse(await response.json() as AntigravityResponseEvent)
  }
}
