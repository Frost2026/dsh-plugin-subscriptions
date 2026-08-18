/**
 * Runtime detection of the locally installed Claude Code CLI version and
 * beta flags.  Exercises both the happy path (claude binary on $PATH) and
 * the fallback path (binary absent or broken).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectClaudeVersion,
  detectBetaFlags,
  CLAUDE_CLI_FALLBACK_VERSION,
  CLAUDE_BETA_FALLBACK,
} from '../src/providers/claude.js'

// ---------------------------------------------------------------------------
// detectClaudeVersion
// ---------------------------------------------------------------------------

test('detectClaudeVersion returns a semver-shaped string', () => {
  const version = detectClaudeVersion()
  assert.match(version, /^\d+\.\d+\.\d+$/, `expected semver, got "${version}"`)
})

test('detectClaudeVersion fallback is a valid semver', () => {
  assert.match(CLAUDE_CLI_FALLBACK_VERSION, /^\d+\.\d+\.\d+$/)
})

test('detectClaudeVersion returns the fallback when claude is not in PATH', () => {
  // Temporarily break PATH so `claude` cannot be found.
  const original = process.env.PATH
  try {
    process.env.PATH = ''
    const version = detectClaudeVersion()
    assert.equal(version, CLAUDE_CLI_FALLBACK_VERSION)
  } finally {
    process.env.PATH = original
  }
})

// ---------------------------------------------------------------------------
// detectBetaFlags
// ---------------------------------------------------------------------------

const REQUIRED_FLAGS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
]

test('detectBetaFlags returns a non-empty comma-separated string', () => {
  const flags = detectBetaFlags()
  assert.ok(flags.length > 0, 'flags must not be empty')
  assert.ok(!flags.startsWith(',') && !flags.endsWith(','), 'no leading/trailing commas')
  for (const flag of flags.split(',')) {
    assert.match(flag, /^[a-z][\w-]+-\d{4}-\d{2}-\d{2}$/, `malformed flag: "${flag}"`)
  }
})

test('detectBetaFlags includes all required base flags', () => {
  const flags = detectBetaFlags().split(',')
  for (const required of REQUIRED_FLAGS) {
    assert.ok(flags.includes(required), `missing required flag: ${required}`)
  }
})

test('CLAUDE_BETA_FALLBACK contains all required base flags', () => {
  const flags = CLAUDE_BETA_FALLBACK.split(',')
  for (const required of REQUIRED_FLAGS) {
    assert.ok(flags.includes(required), `fallback missing: ${required}`)
  }
})

test('CLAUDE_BETA_FALLBACK includes the new flags from Claude Code 2.1.234', () => {
  const flags = CLAUDE_BETA_FALLBACK.split(',')
  const newFlags = [
    'tool-streaming-2025-05-14',
    'effort-2025-11-24',
    'compact-2026-01-12',
    'mcp-client-2025-11-20',
    'mcp-servers-2025-12-04',
    'agent-memory-2026-07-22',
  ]
  for (const flag of newFlags) {
    assert.ok(flags.includes(flag), `fallback missing new flag: ${flag}`)
  }
})

test('detectBetaFlags returns the fallback when claude is not in PATH', () => {
  const original = process.env.PATH
  try {
    process.env.PATH = ''
    const flags = detectBetaFlags()
    assert.equal(flags, CLAUDE_BETA_FALLBACK)
  } finally {
    process.env.PATH = original
  }
})
