/**
 * Unit tests for the `modelDefaults` / `setModelDefault` endpoints: payload
 * validation, the catalog shape served to the Settings page, and the
 * durable round trip through the per-model defaults store. Drives the real
 * plugin wiring with a fake host connection and a fake llm catalog;
 * DSH_HOME is redirected to a temp dir so the store file never leaks.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'model-defaults-rpc-test-'))

// Imports after the env override so the store path resolves under the temp home.
const plugin = await import('../src/index.js')

interface FakeLlm {
  registered: string[]
  replaced: string[]
}

/** Mount the plugin with a fake llm catalog; return its RPC handler. */
async function mount(): Promise<{ handler: ConnectionRpcHandler; fake: FakeLlm }> {
  let handler: ConnectionRpcHandler | undefined
  const fake: FakeLlm = { registered: [], replaced: [] }
  const ctx = new Context()
  const fakeLlm = {
    listProviders: async (): Promise<{ id: string; name: string }[]> => [{ id: 'codex', name: 'Codex (ChatGPT)' }],
    listModels: async (): Promise<{ id: string; name: string }[]> => [{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' }],
    resolveModelInfo: async (provider: string, model: string) => ({
      provider,
      id: model,
      name: 'GPT-5.6-Sol',
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('low'),
      },
    }),
    registerAdapter: (providers: string[]) => {
      fake.registered.push(...providers)
      return Object.assign(() => {}, {
        replace: (next: string[]) => { fake.replaced.push(...next) },
      })
    },
  }
  ctx.provide('llm', fakeLlm)
  ctx.provide('connection', {
    rpc: {
      handle: (_channel: string, h: ConnectionRpcHandler) => {
        handler = h
        return () => Promise.resolve()
      },
    },
  })
  ctx.plugin(plugin, { providers: ['codex'] })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(handler !== undefined, 'the /subscriptions-auth channel was registered')
  return { handler, fake }
}

async function call(
  handler: ConnectionRpcHandler,
  endpoint: string,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  return handler(endpoint, payload, new AbortController().signal)
}

test('modelDefaults serves the listed models with their advertised efforts', async () => {
  const { handler } = await mount()
  const result = await call(handler, 'modelDefaults', {})
  assert.equal(result.ok, true)
  if (!result.ok) return
  const value = result.value as { provider: string; models: { id: string; name: string; efforts: { id: string }[]; effective?: string; configured?: string }[] }[]
  assert.equal(value.length, 1)
  assert.equal(value[0]?.provider, 'codex')
  assert.deepEqual(value[0]?.models[0], {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
    effective: 'low',
  })
})

test('setModelDefault persists and the next modelDefaults reports it', async () => {
  const { handler, fake } = await mount()
  const set = await call(handler, 'setModelDefault', {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  })
  assert.deepEqual(set, { ok: true, value: { ok: true } })
  // The route re-announces so the model picker re-queries the catalog.
  assert.deepEqual(fake.replaced, ['codex'])
  const view = await call(handler, 'modelDefaults', {})
  assert.equal(view.ok, true)
  if (!view.ok) return
  const model = (view.value as { provider: string; models: { configured?: string; effective?: string }[] }[])[0]?.models[0]
  assert.equal(model?.configured, 'high')
  assert.equal(model?.effective, 'low', 'the advertised default stays reported')
})

test('setModelDefault without effort clears the override', async () => {
  const { handler } = await mount()
  await call(handler, 'setModelDefault', { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
  await call(handler, 'setModelDefault', { provider: 'codex', model: 'gpt-5.6-sol' })
  const view = await call(handler, 'modelDefaults', {})
  assert.equal(view.ok, true)
  if (!view.ok) return
  const model = (view.value as { provider: string; models: { configured?: string }[] }[])[0]?.models[0]
  assert.equal(model?.configured, undefined)
})

test('setModelDefault rejects unknown providers and empty efforts', async () => {
  const { handler } = await mount()
  const badProvider = await call(handler, 'setModelDefault', {
    provider: 'nope',
    model: 'gpt-5.6-sol',
    effort: 'high',
  })
  assert.equal(badProvider.ok, false)
  if (!badProvider.ok) assert.match(badProvider.error.message, /payload.provider must be one of/)
  const badEffort = await call(handler, 'setModelDefault', {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: '',
  })
  assert.equal(badEffort.ok, false)
  if (!badEffort.ok) assert.match(badEffort.error.message, /payload.effort must be a non-empty string/)
})
