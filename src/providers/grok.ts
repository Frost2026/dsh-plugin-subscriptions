/**
 * Grok (X Premium / xAI) subscription provider: OIDC-discovered OAuth against
 * auth.x.ai with the Grok CLI client id, and streaming against the xAI
 * Responses-style endpoint.
 */

import { attributionHeaders, EMPTY_RESPONSE_CODE, errorChain, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { decodeJwtPayload } from '../auth/jwt.js'
import type { FlowSpec } from '../auth/oauth-flow.js'
import type { GrokSession } from '../auth/store.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveImages } from '../translate/resolved.js'
import { streamResponses, toResponsesInput, toResponsesTools } from '../translate/responses.js'
import {
  httpLlmError,
  idleWatchdog,
  mapFetchFailure,
  ModelCatalogCache,
  oauthEndpointError,
  OAuthEndpointError,
  TokenManager,
} from './common.js'
import type { DiscoveredModel, FetchFn, ModelEntry } from './common.js'

export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
export const GROK_DISCOVERY_URL = 'https://auth.x.ai/.well-known/openid-configuration'
export const GROK_API_URL = 'https://api.x.ai/v1/responses'
const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
const GROK_CALLBACK_PATH = '/callback'
const GROK_CONTEXT_WINDOW = 256_000
const GROK_DEFAULT_MAX_TOKENS = 32_000
/** Refresh when the access token has less than this much life left. */
export const GROK_PREEMPT_MS = 2 * 60_000

/** Discovered OIDC endpoints for the xAI authorization server. */
export interface GrokDiscovery {
  authorizationEndpoint: string
  tokenEndpoint: string
}

/** A discovered URL must be https on x.ai or a subdomain; anything else is a hostile document. */
function assertXaiEndpoint(url: string, field: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`grok OIDC discovery returned an invalid ${field}`)
  }
  if (parsed.protocol !== 'https:'
    || (parsed.hostname !== 'x.ai' && !parsed.hostname.endsWith('.x.ai'))) {
    throw new Error(`grok OIDC discovery returned a non-x.ai ${field}: ${url}`)
  }
  return url
}

let discoveryCache: GrokDiscovery | undefined

/**
 * Resolve the xAI OIDC endpoints (cached after the first fetch).
 * @returns validated authorization and token endpoints.
 */
export async function grokDiscovery(): Promise<GrokDiscovery> {
  if (discoveryCache !== undefined) return discoveryCache
  const response = await fetch(GROK_DISCOVERY_URL)
  if (!response.ok) throw await oauthEndpointError(response, 'grok OIDC discovery')
  const document = await response.json() as {
    authorization_endpoint?: string
    token_endpoint?: string
  }
  if (typeof document.authorization_endpoint !== 'string' || typeof document.token_endpoint !== 'string') {
    throw new Error('grok OIDC discovery document is missing endpoints')
  }
  discoveryCache = {
    authorizationEndpoint: assertXaiEndpoint(document.authorization_endpoint, 'authorization_endpoint'),
    tokenEndpoint: assertXaiEndpoint(document.token_endpoint, 'token_endpoint'),
  }
  return discoveryCache
}

/**
 * Build the grok flow facts for the OAuth flow engine (async because the
 * authorize URL comes from OIDC discovery).
 * @returns the flow spec for one attempt.
 */
export async function grokFlow(): Promise<FlowSpec> {
  const discovery = await grokDiscovery()
  return {
    callbackPath: GROK_CALLBACK_PATH,
    listen: { host: '127.0.0.1', ports: [56121] },
    buildAuthorizeUrl({ redirectUri, state, pkce, nonce }) {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: GROK_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: GROK_SCOPE,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state,
        nonce,
        plan: 'generic',
        referrer: 'dsh-plugin-subscriptions',
      })
      return `${discovery.authorizationEndpoint}?${params.toString()}`
    },
  }
}

/** Token endpoint response shape (subset). */
interface GrokTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
  scope?: string
}

/** Pick a display account from an id token's claims. */
function grokAccount(idToken: string | undefined): string | undefined {
  const payload = idToken === undefined ? undefined : decodeJwtPayload(idToken)
  const claim = payload?.email ?? payload?.preferred_username ?? payload?.name ?? payload?.sub
  return typeof claim === 'string' && claim.length > 0 ? claim : undefined
}

/** Build a session from a token response. */
function grokSession(
  tokens: GrokTokenResponse,
  tokenEndpoint: string,
  fallbackRefreshToken?: string,
): GrokSession {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new Error('grok token endpoint returned no access token')
  }
  const refreshToken = tokens.refresh_token ?? fallbackRefreshToken
  if (refreshToken === undefined) throw new Error('grok token endpoint returned no refresh token')
  if (typeof tokens.expires_in !== 'number' || tokens.expires_in <= 0) {
    throw new Error('grok token endpoint returned no usable expiry')
  }
  const account = grokAccount(tokens.id_token)
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    tokenEndpoint,
    ...typeof tokens.scope === 'string' ? { scopes: tokens.scope } : {},
    ...account === undefined ? {} : { account },
  }
}

/**
 * Exchange an authorization code for a grok session (form-encoded grant that
 * echoes the PKCE challenge as well as the verifier, per the xAI flow).
 * A 403 here means the X plan lacks the API OAuth entitlement.
 * @param code - the authorization code from the callback.
 * @param verifier - the PKCE verifier minted for the attempt.
 * @param redirectUri - the attempt's redirect URI.
 * @param challenge - the PKCE challenge sent at authorize time.
 * @returns the session to store.
 */
export async function exchangeGrokCode(
  code: string,
  verifier: string,
  redirectUri: string,
  challenge: string,
): Promise<GrokSession> {
  const discovery = await grokDiscovery()
  const response = await fetch(discovery.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: GROK_CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString(),
  })
  if (response.status === 403) {
    throw new OAuthEndpointError(
      'grok token endpoint refused the exchange (HTTP 403): your X plan does not include '
      + 'the API OAuth entitlement; an X Premium or xAI subscription with API access is required',
      403,
    )
  }
  if (!response.ok) throw await oauthEndpointError(response, 'grok')
  return grokSession(await response.json() as GrokTokenResponse, discovery.tokenEndpoint)
}

/**
 * Refresh a grok session (form-encoded grant).
 * @param session - the stored session.
 * @returns the fresh session to store.
 */
export async function refreshGrok(session: GrokSession): Promise<GrokSession> {
  const response = await fetch(session.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GROK_CLIENT_ID,
      refresh_token: session.refreshToken,
    }).toString(),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'grok')
  const next = grokSession(await response.json() as GrokTokenResponse, session.tokenEndpoint, session.refreshToken)
  return {
    ...next,
    ...session.account === undefined ? {} : { account: session.account },
    ...next.scopes === undefined && session.scopes !== undefined ? { scopes: session.scopes } : {},
  }
}

/**
 * Whether a grok refresh failure means the login is permanently gone.
 * @param error - the thrown refresh error.
 * @returns true when re-login is the only fix.
 */
export function isGrokPermanentRefreshError(error: unknown): boolean {
  return error instanceof OAuthEndpointError && error.oauthCode === 'invalid_grant'
}

export const GROK_MODELS_URL = 'https://api.x.ai/v1/models'

/**
 * Input modalities for one grok model: chat models (grok-4 family) accept
 * images; code and embedding models are text-only.
 */
function grokModalities(id: string): readonly ('text' | 'image')[] {
  return /code|embed/i.test(id) ? ['text'] : ['text', 'image']
}

/**
 * The /v1/models list also serves generation models that cannot chat
 * (grok-imagine-image*, grok-imagine-video*) and embedding models; the picker
 * must not offer them. Heuristic over the id substring, verified against the
 * live catalog (grok-build-0.1 and the grok-4 family pass).
 */
function isChatModel(id: string): boolean {
  return !/imagine|image-|video|embed/i.test(id)
}

/**
 * Fetch the live grok model list.
 * @param session - the stored session (used as-is; never refreshed here).
 * @param fetchFn - fetch implementation (injectable for tests).
 * @returns discovered chat models in endpoint order (id doubles as the name).
 */
export async function fetchGrokModels(session: GrokSession, fetchFn: FetchFn = fetch): Promise<DiscoveredModel[]> {
  const response = await fetchFn(GROK_MODELS_URL, {
    headers: {
      'authorization': `Bearer ${session.accessToken}`,
      'accept': 'application/json',
      ...attributionHeaders(),
    },
  })
  if (!response.ok) throw await oauthEndpointError(response, 'grok models')
  const payload = await response.json() as { data?: { id?: string }[] }
  if (!Array.isArray(payload.data)) throw new Error('grok models endpoint returned no data array')
  const seen = new Set<string>()
  const discovered: DiscoveredModel[] = []
  for (const entry of payload.data) {
    if (typeof entry.id !== 'string' || entry.id.length === 0 || seen.has(entry.id)) continue
    if (!isChatModel(entry.id)) continue
    seen.add(entry.id)
    discovered.push({ id: entry.id, name: entry.id })
  }
  // An empty catalog from a 200 response is treated as a discovery failure so
  // the adapter falls back to the static catalog instead of vanishing from
  // the picker.
  if (discovered.length === 0) throw new Error('grok models endpoint returned an empty catalog')
  return discovered
}

/** Constructor dependencies for {@link GrokAdapter}. */
export interface GrokAdapterOptions {
  models: readonly ModelEntry[]
  streamIdleTimeoutMs: number
  tokens: TokenManager<GrokSession>
  /** Whether to fetch the live catalog when logged in (false when config `models` overrides). */
  discovery: boolean
  /** Warning sink for discovery failures that fall back to the static catalog. */
  onWarn?: (message: string) => void
  /** Fetch implementation for discovery (defaults to global fetch). */
  fetchFn?: FetchFn
  /** Resolve the attachment service per request; absent means image requests fail loudly. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** Grok wire adapter: one instance serves the `grok` provider route. */
export class GrokAdapter extends LlmAdapter {
  private readonly catalog = new ModelCatalogCache()

  constructor(private readonly options: GrokAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Grok (Subscription)' }
  }

  private staticModels(provider: string): LlmModelInfo[] {
    return this.options.models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities: model.inputModalities ?? grokModalities(model.id),
    }))
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // Not logged in → empty catalog, so the web picker drops the provider.
    const session = await this.options.tokens.peek()
    if (session === undefined) return []
    if (!this.options.discovery) return this.staticModels(provider)
    try {
      const discovered = await this.catalog.get(() => fetchGrokModels(session, this.options.fetchFn))
      return discovered.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: grokModalities(model.id),
      }))
    } catch (error: unknown) {
      if (error instanceof OAuthEndpointError && error.status === 401) this.catalog.invalidate()
      this.options.onWarn?.(
        `grok model discovery failed; using the built-in catalog (${errorChain(error)})`,
      )
      return this.staticModels(provider)
    }
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const discovered = this.options.discovery
      ? this.catalog.cached()?.find(entry => entry.id === model)
      : undefined
    const configured = this.options.models.find(entry => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: discovered?.name ?? configured?.name ?? model,
      inputModalities: configured?.inputModalities ?? grokModalities(model),
      context: { contextWindow: configured?.contextWindow ?? GROK_CONTEXT_WINDOW },
      defaultMaxTokens: configured?.maxTokens ?? GROK_DEFAULT_MAX_TOKENS,
      // No reasoning metadata: effort selection is not exposed for grok.
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
      if (!response.ok) throw await httpLlmError(response, 'grok API')
      if (response.body === null) {
        throw new LlmError('grok API returned no response body', EMPTY_RESPONSE_CODE)
      }
      yield* streamResponses(response.body, () => { watchdog.pulse() })
    } catch (error: unknown) {
      throw mapFetchFailure('grok API', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  private async request(options: GenerateOptions, session: GrokSession, signal: AbortSignal): Promise<Response> {
    const messages = await resolveImages(options.messages, this.options.resolveAttachments?.(), signal)
    const { instructions, input } = toResponsesInput(messages, options.system)
    const body = {
      model: options.model,
      ...instructions === undefined ? {} : { instructions },
      input,
      ...options.tools !== undefined && options.tools.length > 0
        ? { tools: toResponsesTools(options.tools) }
        : {},
      tool_choice: 'auto',
      parallel_tool_calls: true,
      ...options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {},
      store: false,
      stream: true,
    }
    return fetch(GROK_API_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${session.accessToken}`,
        'accept': 'text/event-stream',
        'content-type': 'application/json',
        ...attributionHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    })
  }
}
