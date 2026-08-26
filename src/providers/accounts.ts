/**
 * Multi-account token plumbing: one {@link AccountTokenManager} per provider
 * owns a lazily-built {@link TokenManager} per account, so refresh coalescing
 * (`inflight`) and permanent-failure removal stay scoped to ONE account —
 * a revoked account deletes itself without touching its siblings.
 *
 * {@link AccountAwareAdapter} is the internal interface the pool uses to
 * stream through a specific account; plain `stream()` always serves the
 * provider's default account.
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { TokenManager } from './common.js'
import type { TokenManagerOptions } from './common.js'
import {
  deleteAccountSession,
  getAccountSession,
  listAccounts,
  saveAccountSession,
} from '../auth/store.js'
import type { AccountEntry, ProviderId } from '../auth/store.js'

/** Minimal session shape the token managers need (mirrors common.ts). */
interface TimedSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/** An adapter that can stream through a named account (the pool's seam). */
export interface AccountAwareAdapter extends LlmAdapter {
  /** Stream using the given account's credentials instead of the default. */
  streamAccount(options: GenerateOptions, account: string): AsyncIterable<StreamChunk>
  /** The provider's own catalog, without pooled entries (family aggregation reads this). */
  listOwnModels(provider: string): Promise<readonly LlmModelInfo[]>
  /**
   * Capability resolution of the provider's OWN models, bypassing the pool
   * delegation. The pool resolves its members through this — a member whose
   * wire id equals the pool id (e.g. codex owning the `gpt-5.4` family)
   * would otherwise delegate straight back into the pool forever.
   */
  resolveOwnModel(provider: string, model: string): Promise<LlmResolvedModelInfo>
}

/** Store I/O behind {@link AccountTokenManager} (injectable for tests). */
export interface AccountStoreIo<S> {
  list(): Promise<AccountEntry<S>[]>
  get(account?: string): Promise<S | undefined>
  save(account: string, session: S): Promise<void>
  remove(account: string): Promise<void>
}

export interface AccountTokenManagerOptions<S extends TimedSession> {
  provider: ProviderId
  /** Human-readable provider name for error messages. */
  displayName: string
  /** Provider hooks shared by every account (load/save/remove are bound per account). */
  makeOptions: (account: string) => Omit<TokenManagerOptions<S>, 'load' | 'save' | 'remove' | 'onRemoved' | 'displayName'>
  /** Called after a permanent refresh failure deleted one account's session. */
  onAccountRemoved?: (account: string) => void
  /** Store backend; defaults to the durable auth store. */
  io?: AccountStoreIo<S>
}

export class AccountTokenManager<S extends TimedSession> {
  private readonly managers = new Map<string, TokenManager<S>>()
  private readonly io: AccountStoreIo<S>

  constructor(private readonly options: AccountTokenManagerOptions<S>) {
    const provider = options.provider
    this.io = options.io ?? {
      list: () => listAccounts(provider) as Promise<AccountEntry<S>[]>,
      get: account => getAccountSession(provider, account) as Promise<S | undefined>,
      save: (account, session) => saveAccountSession(provider, account, session as never),
      remove: account => deleteAccountSession(provider, account),
    }
  }

  /** The provider's accounts, default first (straight from the store). */
  list(): Promise<AccountEntry<S>[]> {
    return this.io.list()
  }

  /** The default account's key, or undefined when logged out. */
  async defaultAccount(): Promise<string | undefined> {
    return (await this.list())[0]?.key
  }

  /**
   * Resolve a usable session for one account (default when omitted),
   * refreshing proactively or on demand.
   * @param account - the account key; the default account when undefined.
   * @param forceRefresh - refresh regardless of expiry (used after a 401).
   * @returns the persisted session to send.
   * @throws LlmError MISSING_CREDENTIAL when the account is not logged in.
   */
  async session(account?: string, forceRefresh = false): Promise<S> {
    const key = account ?? await this.defaultAccount()
    if (key === undefined) throw this.missingCredential()
    return this.tokensFor(key).session(forceRefresh)
  }

  /** Read an account's stored session without any refresh side effect. */
  peek(account?: string): Promise<S | undefined> {
    return this.io.get(account)
  }

  /** Whether a session is stored for the account (cheap; never refreshes). */
  async hasSession(account?: string): Promise<boolean> {
    return (await this.peek(account)) !== undefined
  }

  /** The TokenManager bound to one account (created lazily, then cached). */
  tokensFor(account: string): TokenManager<S> {
    let manager = this.managers.get(account)
    if (manager === undefined) {
      const io = this.io
      manager = new TokenManager<S>({
        displayName: this.options.displayName,
        ...this.options.makeOptions(account),
        load: () => io.get(account),
        save: session => io.save(account, session),
        remove: () => io.remove(account),
        onRemoved: () => { this.options.onAccountRemoved?.(account) },
      })
      this.managers.set(account, manager)
    }
    return manager
  }

  /** The logged-out error, mirroring TokenManager's own message. */
  private missingCredential(): LlmError {
    return new LlmError(
      `dsh-plugin-subscriptions: not logged in to ${this.options.displayName}; `
      + 'log in via Settings → Subscriptions in the dsh web app',
      'MISSING_CREDENTIAL',
    )
  }
}
