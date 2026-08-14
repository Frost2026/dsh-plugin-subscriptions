/**
 * Subscriptions settings section: one card per subscription provider with an
 * OAuth login/logout flow driven by the node half's `/subscriptions-auth` RPC
 * channel. Login state lives server-side; the page polls `status` only while
 * a login attempt is busy, so an idle page never polls. All state is local
 * React state — the page has no store.
 *
 * Every color resolves through a `--dsw-alias-*` design token (the ui-theme
 * design-platform.css values flip under `body[data-ds-dark-theme]`), and
 * every user-visible string goes through the locale-bound `t` of the
 * 'settings.subscriptions' namespace. Buttons and inputs take the
 * ModelsSection vocabulary minus hover rules, which inline styles cannot
 * express.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle, RpcResult } from '@deepseek-ai/dsh-api-remotes/client'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

/** Logical RPC channel served by the node half of this plugin. */
const SUBSCRIPTIONS_AUTH_CHANNEL = '/subscriptions-auth'

/** Poll cadence while a provider login attempt is busy. */
const POLL_INTERVAL_MS = 2000

/** Subscription provider ids, fixed by the node half's OAuth adapters. */
export type SubscriptionProvider = 'codex' | 'claude' | 'grok'

/** One provider's login state as answered by the `status` endpoint. */
export interface ProviderStatus {
  loggedIn: boolean
  busy: boolean
  expiresAt?: number
  account?: string
  detail?: string
}

/** `status` endpoint value: the node half owns this shape. */
interface StatusResponse {
  providers: Record<SubscriptionProvider, ProviderStatus>
}

/** `login` endpoint value: the URL the user completes OAuth at. */
interface LoginResponse {
  authorizeUrl: string
}

/** Injected dependencies of {@link SubscriptionsSection} (slot `inject`). */
export interface SubscriptionsSectionInjected {
  /** Generic logical-RPC caller over the Connection transport. */
  rpc: ConnectionHandle['rpc']
  /** Section copy: translate a 'settings.subscriptions' key with `{name}` template params. */
  t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type SubscriptionsSectionProps = Partial<SubscriptionsSectionInjected>

/** Card display metadata, in page order (names are brand names, not translated). */
const PROVIDERS: readonly { id: SubscriptionProvider; name: string }[] = [
  { id: 'codex', name: 'Codex (ChatGPT)' },
  { id: 'claude', name: 'Claude' },
  { id: 'grok', name: 'Grok (X Premium)' },
]

/** Business error returned by the `/subscriptions-auth` channel (error branch message). */
class SubscriptionsAuthError extends Error {}

/**
 * Call one `/subscriptions-auth` endpoint and unwrap the business result.
 * @param rpc - Connection RPC caller.
 * @param endpoint - channel-relative endpoint.
 * @param payload - channel-owned request payload.
 * @returns the success value, cast by the caller to the endpoint's shape.
 */
async function callSubscriptionsAuth<T>(rpc: ConnectionHandle['rpc'], endpoint: string, payload: unknown): Promise<T> {
  let result: RpcResult<unknown>
  try {
    result = await rpc.call(SUBSCRIPTIONS_AUTH_CHANNEL, endpoint, payload)
  } catch (error) {
    // The transport rejected rather than answering; surface the same way.
    throw new SubscriptionsAuthError(error instanceof Error ? error.message : String(error))
  }
  if (!result.ok) throw new SubscriptionsAuthError(result.error.message)
  return result.value as T
}

/** Human text of an action failure, SubscriptionsAuthError or not. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * English-dictionary fallback for a missing inject `t` (standalone renders);
 * the slot inject always supplies the locale-bound one.
 * @param key - dictionary key.
 * @param params - `{name}` template params.
 * @returns the template with params substituted.
 */
function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

const styles: Record<string, CSSProperties> = {
  section: {
    display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560,
    color: 'var(--dsw-alias-label-primary)',
  },
  intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, lineHeight: '22px' },
  card: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
  },
  cardHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  name: { fontWeight: 500, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
  statusLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  errorLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
  actions: { display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' },
  button: {
    boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    height: 28, padding: '0 10px', borderRadius: 14,
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12, lineHeight: '18px',
    cursor: 'pointer',
  },
  manual: { marginTop: 4, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
  manualRow: { display: 'flex', gap: 8, marginTop: 6 },
  manualInput: {
    flex: 1, height: 32, boxSizing: 'border-box',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '0 10px', font: 'inherit', fontSize: 14, lineHeight: '22px',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  },
}

/** Status dot color for one provider state. */
function dotColor(status: ProviderStatus | undefined): string {
  if (status?.busy === true) return 'var(--dsw-alias-state-warn-label)'
  if (status?.loggedIn === true) return 'var(--dsw-alias-state-success-primary)'
  return 'var(--dsw-alias-label-dimmed)'
}

/**
 * One-line status text for one provider state.
 * @param t - section translate.
 * @param status - the provider's last reported state.
 * @returns the localized status line.
 */
function statusText(t: SubscriptionsSectionInjected['t'], status: ProviderStatus | undefined): string {
  if (status === undefined) return t('checking')
  if (status.busy) return t('loginInProgress')
  if (status.loggedIn) {
    const params: Record<string, unknown> = {}
    if (status.account !== undefined) params.account = status.account
    if (status.expiresAt !== undefined) params.date = new Date(status.expiresAt).toLocaleString()
    if (params.account !== undefined && params.date !== undefined) return t('loggedInAccountExpires', params)
    if (params.account !== undefined) return t('loggedInAccount', params)
    if (params.date !== undefined) return t('loggedInExpires', params)
    return t('loggedIn')
  }
  return t('notLoggedIn')
}

/**
 * The Subscriptions settings page component.
 * @param props - the slot inject face ({@link SubscriptionsSectionInjected}).
 * @returns the section body, or a notice while the RPC face is absent.
 */
export function SubscriptionsSection(props: SubscriptionsSectionProps) {
  const { rpc } = props
  const t = props.t ?? fallbackTranslate
  const [statuses, setStatuses] = useState<Partial<Record<SubscriptionProvider, ProviderStatus>>>({})
  const [errors, setErrors] = useState<Partial<Record<SubscriptionProvider, string>>>({})
  const [manualDrafts, setManualDrafts] = useState<Record<SubscriptionProvider, string>>({
    codex: '', claude: '', grok: '',
  })
  const mountedRef = useRef(true)
  const pollersRef = useRef(new Map<SubscriptionProvider, ReturnType<typeof setInterval>>())

  const setProviderError = useCallback((provider: SubscriptionProvider, message: string | undefined): void => {
    if (!mountedRef.current) return
    setErrors((prev) => {
      const next = { ...prev }
      if (message === undefined) delete next[provider]
      else next[provider] = message
      return next
    })
  }, [])

  const stopPolling = useCallback((provider: SubscriptionProvider): void => {
    const poller = pollersRef.current.get(provider)
    if (poller !== undefined) {
      clearInterval(poller)
      pollersRef.current.delete(provider)
    }
  }, [])

  /** Refetch every provider's status; stop a provider's poller once its attempt settles. */
  const refresh = useCallback(async (): Promise<void> => {
    if (rpc === undefined) return
    let response: StatusResponse
    try {
      response = await callSubscriptionsAuth<StatusResponse>(rpc, 'status', {})
    } catch {
      // A failed poll must not kill the page; busy providers keep polling and
      // the action paths report their own errors.
      return
    }
    if (!mountedRef.current) return
    setStatuses(response.providers)
    for (const { id } of PROVIDERS) {
      const status = response.providers[id]
      if (status.loggedIn || !status.busy) stopPolling(id)
    }
  }, [rpc, stopPolling])

  const startPolling = useCallback((provider: SubscriptionProvider): void => {
    if (pollersRef.current.has(provider)) return
    pollersRef.current.set(provider, setInterval(() => { void refresh() }, POLL_INTERVAL_MS))
  }, [refresh])

  // Initial load; every busy provider (e.g. an attempt started before a page
  // reload) resumes polling. Teardown clears pollers and the mounted guard.
  useEffect(() => {
    mountedRef.current = true
    void refresh().then(() => {
      if (!mountedRef.current) return
      setStatuses((current) => {
        for (const { id } of PROVIDERS) {
          if (current[id]?.busy === true) startPolling(id)
        }
        return current
      })
    })
    return () => {
      mountedRef.current = false
      for (const poller of pollersRef.current.values()) clearInterval(poller)
      pollersRef.current.clear()
    }
  }, [refresh, startPolling])

  const login = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    setProviderError(provider, undefined)
    try {
      const response = await callSubscriptionsAuth<LoginResponse>(rpc, 'login', { provider })
      if (typeof response.authorizeUrl !== 'string' || response.authorizeUrl === '') {
        throw new SubscriptionsAuthError(t('loginMissingUrl'))
      }
      window.open(response.authorizeUrl, '_blank', 'noopener')
      if (!mountedRef.current) return
      // Optimistic busy so Cancel and the manual fallback appear before the first poll tick.
      setStatuses(prev => ({ ...prev, [provider]: { ...prev[provider], busy: true, loggedIn: false } }))
      startPolling(provider)
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
  }, [rpc, t, setProviderError, startPolling])

  const cancel = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    stopPolling(provider)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'cancel', { provider })
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, stopPolling, setProviderError, refresh])

  const submitManual = useCallback(async (provider: SubscriptionProvider): Promise<void> => {
    if (rpc === undefined) return
    const input = manualDrafts[provider].trim()
    if (input === '') return
    setProviderError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'manual', { provider, input })
      if (mountedRef.current) setManualDrafts(prev => ({ ...prev, [provider]: '' }))
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, manualDrafts, setProviderError, refresh])

  const logout = useCallback(async (provider: SubscriptionProvider, name: string): Promise<void> => {
    if (rpc === undefined) return
    if (!window.confirm(t('logoutConfirm', { provider: name }))) return
    setProviderError(provider, undefined)
    try {
      await callSubscriptionsAuth<{ ok: true }>(rpc, 'logout', { provider })
    } catch (error) {
      setProviderError(provider, messageOf(error))
    }
    await refresh()
  }, [rpc, t, setProviderError, refresh])

  if (rpc === undefined) {
    return <p style={styles.intro}>{t('unavailable')}</p>
  }

  return (
    <div style={styles.section}>
      <p style={styles.intro}>{t('intro')}</p>
      {PROVIDERS.map(({ id, name }) => {
        const status = statuses[id]
        const busy = status?.busy === true
        return (
          <div key={id} style={styles.card}>
            <div style={styles.cardHeader}>
              <span style={{ ...styles.dot, background: dotColor(status) }} />
              <span style={styles.name}>{name}</span>
            </div>
            <p style={styles.statusLine}>{statusText(t, status)}</p>
            {status?.detail !== undefined && status.detail !== '' && (
              <p style={styles.statusLine}>{status.detail}</p>
            )}
            {errors[id] !== undefined && <p style={styles.errorLine}>{errors[id]}</p>}
            <div style={styles.actions}>
              {!busy && status?.loggedIn !== true && (
                <button type="button" style={styles.button} onClick={() => { void login(id) }}>
                  {t('login')}
                </button>
              )}
              {busy && (
                <button type="button" style={styles.button} onClick={() => { void cancel(id) }}>
                  {t('cancel')}
                </button>
              )}
              {status?.loggedIn === true && (
                <button type="button" style={styles.button} onClick={() => { void logout(id, name) }}>
                  {t('logout')}
                </button>
              )}
            </div>
            {busy && (
              <details style={styles.manual}>
                <summary>{t('manualSummary')}</summary>
                <div style={styles.manualRow}>
                  <input
                    style={styles.manualInput}
                    value={manualDrafts[id]}
                    placeholder={t('manualPlaceholder')}
                    onChange={event => setManualDrafts(prev => ({ ...prev, [id]: event.target.value }))}
                  />
                  <button type="button" style={styles.button} onClick={() => { void submitManual(id) }}>
                    {t('submit')}
                  </button>
                </div>
              </details>
            )}
          </div>
        )
      })}
    </div>
  )
}
