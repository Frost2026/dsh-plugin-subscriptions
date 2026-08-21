/**
 * The session store under concurrency. Every writer does a read-modify-write
 * of one JSON file — logins, logouts and the token refreshes each provider
 * adapter fires on its own schedule — so two writers overlapping must not cost
 * a provider its session.
 *
 * Each test writes to its own temp path, passed explicitly, so nothing here
 * depends on `$DSH_HOME` or touches a developer's real store.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deleteSession, loadStore, saveSession } from '../src/auth/store.js'
import type { ClaudeSession, CodexSession } from '../src/auth/store.js'

const TEMP_DIRS: string[] = []

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

/** A store path inside a temp directory removed when the file finishes. */
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'store-spec-'))
  TEMP_DIRS.push(dir)
  return join(dir, 'auth.json')
}

const CODEX: CodexSession = {
  accessToken: 'codex-at',
  refreshToken: 'codex-rt',
  expiresAt: Date.now() + 3600_000,
  accountId: 'acct-1',
}

const CLAUDE: ClaudeSession = {
  accessToken: 'claude-at',
  refreshToken: 'claude-rt',
  expiresAt: Date.now() + 3600_000,
  scopes: 'user:inference',
}

test('two providers refreshing at once both keep their session', async () => {
  // The shape of a real double refresh: each adapter saves its own provider,
  // neither knows about the other. Unserialized, both read the same store and
  // the second write drops the first provider's entry.
  const path = storePath()
  await Promise.all([
    saveSession('codex', CODEX, path),
    saveSession('claude', CLAUDE, path),
  ])
  const store = await loadStore(path)
  assert.equal(store.codex?.accessToken, CODEX.accessToken, 'the codex session survived')
  assert.equal(store.claude?.accessToken, CLAUDE.accessToken, 'the claude session survived')
})

test('a logout concurrent with another provider’s save loses neither', async () => {
  const path = storePath()
  await saveSession('codex', CODEX, path)
  await Promise.all([
    deleteSession('codex', path),
    saveSession('claude', CLAUDE, path),
  ])
  const store = await loadStore(path)
  assert.equal(store.codex, undefined, 'the logout was not undone')
  assert.equal(store.claude?.accessToken, CLAUDE.accessToken, 'the concurrent save was not lost')
})

test('writes to one path settle in call order', async () => {
  const path = storePath()
  const writes = [
    saveSession('claude', { ...CLAUDE, accessToken: 'first' }, path),
    saveSession('claude', { ...CLAUDE, accessToken: 'second' }, path),
    saveSession('claude', { ...CLAUDE, accessToken: 'third' }, path),
  ]
  await Promise.all(writes)
  assert.equal((await loadStore(path)).claude?.accessToken, 'third', 'the last caller wins')
})
