/**
 * Copilot provider unit tests beyond the catalog (models.spec.ts): the VS
 * Code version resolution behind the Editor-Version header, and the
 * GitHub-token → Copilot-token exchange. All fetches are injected; no network.
 *
 * Test order matters within this file: the version cache is module-level, so
 * the empty-cache fallback test runs first.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  completeCopilotLogin,
  COPILOT_TOKEN_URL,
  exchangeCopilotToken,
  FALLBACK_VSCODE_VERSION,
  GITHUB_USER_URL,
  isCopilotPermanentRefreshError,
  latestVsCodeVersion,
  refreshCopilot,
  VSCODE_RELEASES_URL,
} from '../src/providers/copilot.js'
import { OAuthEndpointError } from '../src/providers/common.js'
import type { FetchFn } from '../src/providers/common.js'
import type { CopilotSession } from '../src/auth/store.js'

/** A fetch implementation routing canned responses by URL; records request headers. */
function fakeFetch(routes: Record<string, { payload: unknown; status?: number } | Error>): {
  fetchFn: FetchFn
  headers: (url: string) => Record<string, string>[]
} {
  const seen = new Map<string, Record<string, string>[]>()
  const fetchFn: FetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const route = routes[url]
    if (route === undefined) return Promise.reject(new Error(`unexpected fetch to ${url}`))
    const list = seen.get(url) ?? []
    list.push((init?.headers ?? {}) as Record<string, string>)
    seen.set(url, list)
    if (route instanceof Error) return Promise.reject(route)
    return Promise.resolve(new Response(JSON.stringify(route.payload), { status: route.status ?? 200 }))
  }) as FetchFn
  return { fetchFn, headers: url => seen.get(url) ?? [] }
}

test('latestVsCodeVersion falls back to the pinned version when the feed fails (empty cache)', async () => {
  const failing: FetchFn = () => Promise.reject(new Error('offline'))
  assert.equal(await latestVsCodeVersion(failing, true), FALLBACK_VSCODE_VERSION)
})

test('latestVsCodeVersion serves the latest stable from the feed, then the cache', async () => {
  const { fetchFn } = fakeFetch({ [VSCODE_RELEASES_URL]: { payload: ['3.1.4', '3.1.3'] } })
  assert.equal(await latestVsCodeVersion(fetchFn, true), '3.1.4')
  // A throwing fetch must not be consulted while the cache is fresh.
  const offline: FetchFn = () => Promise.reject(new Error('must not be called'))
  assert.equal(await latestVsCodeVersion(offline), '3.1.4')
})

test('latestVsCodeVersion serves the stale cache when a forced refresh fails', async () => {
  const offline: FetchFn = () => Promise.reject(new Error('offline'))
  assert.equal(await latestVsCodeVersion(offline, true), '3.1.4')
})

test('exchangeCopilotToken maps the wire response and presents the editor identity', async () => {
  const { fetchFn, headers } = fakeFetch({
    [VSCODE_RELEASES_URL]: { payload: ['1.2.3'] },
    [COPILOT_TOKEN_URL]: { payload: { token: 'copilot-token', expires_at: 2_000_000_000 } },
  })
  const pair = await exchangeCopilotToken('gh-token', fetchFn)
  assert.equal(pair.accessToken, 'copilot-token')
  assert.equal(pair.expiresAt, 2_000_000_000_000)
  const [sent] = headers(COPILOT_TOKEN_URL)
  assert.equal(sent.authorization, 'Bearer gh-token')
  // The exact version depends on the module-level cache (see the version
  // tests above); only the shape is asserted here.
  assert.match(sent['editor-version'], /^vscode\/\d+\.\d+\.\d+$/)
  assert.equal(sent['copilot-integration-id'], 'vscode-chat')
})

test('exchangeCopilotToken falls back to ~25 minutes when expires_at is absent', async () => {
  const { fetchFn } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { token: 'copilot-token' } },
  })
  const before = Date.now()
  const pair = await exchangeCopilotToken('gh-token', fetchFn)
  assert.ok(pair.expiresAt >= before + 24 * 60_000 && pair.expiresAt <= Date.now() + 25 * 60_000)
})

test('exchangeCopilotToken: a 401 is a permanent login loss', async () => {
  const { fetchFn } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { error: 'unauthorized' }, status: 401 },
  })
  await assert.rejects(
    exchangeCopilotToken('gh-token', fetchFn),
    (error: unknown) => error instanceof OAuthEndpointError && isCopilotPermanentRefreshError(error),
  )
})

test('completeCopilotLogin stores the GitHub token as the refresh token and reads the account', async () => {
  const { fetchFn } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { token: 'copilot-token', expires_at: 2_000_000_000 } },
    [GITHUB_USER_URL]: { payload: { login: 'octocat' } },
  })
  const session = await completeCopilotLogin('gh-token', fetchFn)
  assert.deepEqual(session, {
    accessToken: 'copilot-token',
    refreshToken: 'gh-token',
    expiresAt: 2_000_000_000_000,
    account: 'octocat',
  })
})

test('completeCopilotLogin tolerates a profile lookup failure', async () => {
  const { fetchFn } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { token: 'copilot-token', expires_at: 2_000_000_000 } },
    [GITHUB_USER_URL]: new Error('offline'),
  })
  const session = await completeCopilotLogin('gh-token', fetchFn)
  assert.equal(session.account, undefined)
  assert.equal(session.accessToken, 'copilot-token')
})

test('refreshCopilot re-exchanges and preserves the account', async () => {
  const stored: CopilotSession = {
    accessToken: 'old',
    refreshToken: 'gh-token',
    expiresAt: Date.now() - 1000,
    account: 'octocat',
  }
  const { fetchFn, headers } = fakeFetch({
    [COPILOT_TOKEN_URL]: { payload: { token: 'fresh-token', expires_at: 2_000_000_000 } },
  })
  const next = await refreshCopilot(stored, fetchFn)
  assert.deepEqual(next, {
    accessToken: 'fresh-token',
    refreshToken: 'gh-token',
    expiresAt: 2_000_000_000_000,
    account: 'octocat',
  })
  // The refresh exchanges with the GITHUB token, never the stale Copilot one.
  assert.equal(headers(COPILOT_TOKEN_URL)[0].authorization, 'Bearer gh-token')
})
