/**
 * Request-body construction for the two Responses-wire providers: the tool
 * trio (`tools` / `tool_choice` / `parallel_tool_calls`) must render together
 * or not at all. xAI rejects `tool_choice` without `tools` with 400
 * invalid-argument, so a bare (tool-less) `ctx.llm.stream` call used to fail
 * on every request while the agent loop — which always sends tools — worked.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { codexRequestBody } from '../src/providers/codex.js'
import { grokRequestBody } from '../src/providers/grok.js'
import { toResponsesInput } from '../src/translate/responses.js'

const TOOL = {
  name: 'echo',
  description: 'echo',
  parameters: { type: 'object', properties: {} },
}

function options(tools?: GenerateOptions['tools']): GenerateOptions {
  return {
    provider: 'grok',
    model: 'grok-4.20-0309-non-reasoning',
    messages: [],
    system: 'judge',
    maxTokens: 16,
    ...tools === undefined ? {} : { tools },
  }
}

const resolved = toResponsesInput([], 'judge')

test('grok: tool-less request carries no tool_choice / parallel_tool_calls', () => {
  const body = grokRequestBody(options(), resolved)
  assert.equal(body.tool_choice, undefined)
  assert.equal(body.parallel_tool_calls, undefined)
  assert.equal(body.tools, undefined)
})

test('grok: request with tools keeps the whole trio', () => {
  const body = grokRequestBody(options([TOOL]), resolved)
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.parallel_tool_calls, true)
  assert.equal((body.tools as unknown[]).length, 1)
})

test('grok: empty tools array counts as tool-less', () => {
  const body = grokRequestBody(options([]), resolved)
  assert.equal(body.tool_choice, undefined)
})

test('codex: tool-less request carries no tool_choice / parallel_tool_calls', () => {
  const body = codexRequestBody(options(), resolved, false)
  assert.equal(body.tool_choice, undefined)
  assert.equal(body.parallel_tool_calls, undefined)
})

test('codex: request with tools keeps the whole trio', () => {
  const body = codexRequestBody(options([TOOL]), resolved, false)
  assert.equal(body.tool_choice, 'auto')
  assert.equal(body.parallel_tool_calls, true)
})
