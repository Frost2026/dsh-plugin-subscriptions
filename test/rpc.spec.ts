/**
 * Unit tests for the `/subscriptions-auth` `image` endpoint: payload
 * validation, the base64 round trip through a fake attachment store, and the
 * no-service / read-failure error results. Drives the real plugin wiring with
 * a fake host connection; DSH_HOME is redirected to a temp dir.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'router-rpc-test-'))

// Imports after the env override so the store path resolves under the temp home.
const plugin = await import('../src/index.js')

interface FakeStore {
  readImage(ref: unknown, signal?: AbortSignal): Promise<{ ref: unknown; data: Uint8Array }>
}

/** Mount the plugin with fake llm/connection (and optional attachments); return the RPC handler. */
async function mount(attachments?: FakeStore): Promise<ConnectionRpcHandler> {
  let handler: ConnectionRpcHandler | undefined
  const ctx = new Context()
  ctx.provide('llm', { registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) })
  ctx.provide('connection', {
    rpc: {
      handle: (_channel: string, h: ConnectionRpcHandler) => {
        handler = h
        return () => Promise.resolve()
      },
    },
  })
  if (attachments !== undefined) ctx.provide('attachments', attachments)
  ctx.plugin(plugin, { providers: ['codex'] })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(handler !== undefined, 'the /subscriptions-auth channel was registered')
  return handler
}

const REF = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 2, width: 1, height: 1 }

async function call(
  handler: ConnectionRpcHandler,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  return handler('image', payload, new AbortController().signal)
}

test('image endpoint: base64 round trip through the attachment store', async () => {
  const seen: unknown[] = []
  const handler = await mount({
    readImage: (ref) => {
      seen.push(ref)
      return Promise.resolve({ ref, data: new Uint8Array([104, 105]) })
    },
  })
  const result = await call(handler, REF)
  assert.deepEqual(result, { ok: true, value: { mediaType: 'image/png', dataBase64: 'aGk=' } })
  assert.deepEqual(seen, [REF], 'the full validated reference reaches readImage')
})

test('image endpoint: no attachment service → internal error result', async () => {
  const handler = await mount()
  const result = await call(handler, REF)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'internal')
    assert.match(result.error.message, /no attachment service/)
  }
})

test('image endpoint: read failure → internal error result with the message', async () => {
  const handler = await mount({
    readImage: () => Promise.reject(new Error('digest mismatch')),
  })
  const result = await call(handler, REF)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'internal')
    assert.match(result.error.message, /digest mismatch/)
  }
})

test('image endpoint: payload validation', async () => {
  const handler = await mount({ readImage: () => Promise.reject(new Error('unused')) })
  const bad = [
    [{}, /attachmentId/],
    [{ ...REF, attachmentId: '' }, /attachmentId/],
    [{ ...REF, mediaType: 'image/tiff' }, /mediaType/],
    [{ ...REF, bytes: 0 }, /bytes/],
    [{ ...REF, width: 1.5 }, /width/],
    [{ ...REF, name: 7 }, /name/],
    ['nope', /object/],
  ] as const
  for (const [payload, pattern] of bad) {
    const result = await call(handler, payload)
    assert.equal(result.ok, false, JSON.stringify(payload))
    if (!result.ok) {
      assert.equal(result.error.code, 'bad-request')
      assert.match(result.error.message, pattern)
    }
  }
})
