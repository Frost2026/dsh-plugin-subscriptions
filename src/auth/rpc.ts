/**
 * The `/subscriptions-auth` host RPC channel the web Settings page drives. The
 * channel is registered only when a host `connection` service exists (the web
 * profile); headless compositions load the plugin without it. All business
 * outcomes are returned as RpcResult values; handlers never throw.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { PROVIDER_IDS, type ProviderId } from './store.js'

/** The RPC channel this plugin registers on the host connection. */
export const SUBSCRIPTIONS_AUTH_CHANNEL = '/subscriptions-auth'

/** Login state of one provider, as rendered by the Settings page. */
export interface ProviderStatus {
  /** Whether a session exists in the store. */
  loggedIn: boolean
  /** Whether a login attempt is currently waiting for its code. */
  busy: boolean
  /** Epoch milliseconds at which the stored access token expires. */
  expiresAt?: number
  /** Account email or account id, when known. */
  account?: string
  /** Subscription detail (plan) or the last login error. */
  detail?: string
}

/** Provider-agnostic auth operations the RPC handler delegates to. */
export interface AuthController {
  /** Current status of one provider. */
  status(provider: ProviderId): Promise<ProviderStatus>
  /**
   * Start a background login attempt.
   * @returns the authorize URL for the user's browser.
   * @throws when an attempt is already running for this provider.
   */
  login(provider: ProviderId): Promise<{ authorizeUrl: string }>
  /**
   * Feed a pasted callback URL or bare code into the pending attempt.
   * @throws when no attempt is pending or the input is unusable.
   */
  manual(provider: ProviderId, input: string): Promise<void>
  /** Abort the pending attempt; a no-op when none is pending. */
  cancel(provider: ProviderId): Promise<void>
  /** Delete the stored session. */
  logout(provider: ProviderId): Promise<void>
}

/** Payload carried no usable provider id — an RPC client bug, not a server failure. */
class BadRequest extends Error {}

function ok(value: unknown): RpcResult<unknown> {
  return { ok: true, value }
}

function failure(error: unknown): RpcResult<unknown> {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof BadRequest) {
    // The issues array is zod-shaped upstream; this channel validates by hand.
    return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
  }
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

function readProvider(payload: unknown): ProviderId {
  if (typeof payload !== 'object' || payload === null) throw new BadRequest('payload must be an object')
  const provider = (payload as Record<string, unknown>).provider
  if (typeof provider !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(provider)) {
    throw new BadRequest(`payload.provider must be one of ${PROVIDER_IDS.join(', ')}`)
  }
  return provider as ProviderId
}

function readString(payload: unknown, field: string): string {
  const value = (payload as Record<string, unknown>)[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest(`payload.${field} must be a non-empty string`)
  }
  return value
}

async function dispatch(
  controller: AuthController,
  endpoint: string,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  switch (endpoint) {
    case 'status': {
      const entries = await Promise.all(PROVIDER_IDS.map(
        async provider => [provider, await controller.status(provider)] as const,
      ))
      return ok({ providers: Object.fromEntries(entries) })
    }
    case 'login':
      return ok(await controller.login(readProvider(payload)))
    case 'manual': {
      const provider = readProvider(payload)
      await controller.manual(provider, readString(payload, 'input'))
      return ok({ ok: true })
    }
    case 'cancel':
      await controller.cancel(readProvider(payload))
      return ok({ ok: true })
    case 'logout':
      await controller.logout(readProvider(payload))
      return ok({ ok: true })
    default:
      throw new BadRequest(`unknown /subscriptions-auth endpoint "${endpoint}"`)
  }
}

/**
 * Register the `/subscriptions-auth` RPC channel when a host connection exists.
 * @param ctx - the plugin context (headless profiles have no `connection`).
 * @param controller - the auth operations backing the endpoints.
 */
export function registerAuthRpc(ctx: Context, controller: AuthController): void {
  // `connection` is not in this plugin's inject list (headless compositions
  // lack it), so its startup order is unconstrained: defer registration until
  // the service exists instead of probing once at apply time.
  ctx.inject(['connection'], (ctx) => {
    const connection = ctx.get('connection') as HostConnectionHandle
    ctx.effect(
      () => connection.rpc.handle(
        SUBSCRIPTIONS_AUTH_CHANNEL,
        async (endpoint, payload) => {
          try {
            return await dispatch(controller, endpoint, payload)
          } catch (error) {
            return failure(error)
          }
        },
        { authority: 'loopback' },
      ),
      'dsh-plugin-subscriptions: /subscriptions-auth rpc channel',
    )
  })
}
