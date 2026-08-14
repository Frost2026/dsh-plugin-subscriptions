/**
 * Subscription OAuth login page, browser half. Registers the Subscriptions
 * settings section; every login state fact arrives through the node half's
 * `/subscriptions-auth` RPC channel — this plugin holds no credential state of its
 * own. Section copy rides the client locale service: one 'settings.subscriptions'
 * namespace with zh/en dictionaries, rebound per read so the nav label and
 * page text follow the active locale.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// `.js` extension: this package's tsconfig lacks the reference repo's
// allowImportingTsExtensions/rewriteRelativeImportExtensions pair; under
// nodenext the .js specifier resolves to the .tsx source (see README note).
import { SubscriptionsSection } from './SubscriptionsSection.js'
import type { SubscriptionsSectionInjected } from './SubscriptionsSection.js'
import { en, zh } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

export type { SubscriptionsSectionInjected, SubscriptionsSectionProps } from './SubscriptionsSection.js'
export type { SubscriptionsKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Subscriptions settings page copy. */
    'settings.subscriptions': SubscriptionsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.subscriptions'

/**
 * Required services (cordis fiber inject): `slots` carries the registration
 * seat, `connection` the `/subscriptions-auth` RPC caller, and `locale` the copy
 * dictionaries.
 */
export const inject = ['slots', 'connection', 'locale']

/**
 * Register the Subscriptions section once the `settings.section` declaration
 * is on the ledger (the shell's apply order relative to this one is NOT
 * constrained; registration depends on the slot through `slots.inject()`).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-subscriptions: copy dictionaries')
  // The client-runtime Context merge types `connection` as the host handle;
  // in the browser shell the same key holds the full client ConnectionHandle.
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const t = ctx.locale.bind(NS) as SubscriptionsSectionInjected['t']
  const injected = (): SubscriptionsSectionInjected => ({ rpc: connection.rpc, t })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'subscriptions',
    order: 90,
    // A thunk re-evaluated per read, so the nav label follows the active locale.
    label: () => t('nav'),
    inject: injected,
  }, SubscriptionsSection))
}
