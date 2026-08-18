import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeSession } from './store.js'

const PRIMARY_SERVICE = 'Claude Code-credentials'

interface CredentialBlob {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
    subscriptionType?: string
    emailAddress?: string
  }
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  subscriptionType?: string
  emailAddress?: string
}

function parseBlob(raw: string): ClaudeSession | undefined {
  let parsed: CredentialBlob
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const data = parsed.claudeAiOauth ?? parsed
  if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string' || typeof data.expiresAt !== 'number') {
    return undefined
  }
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: Math.trunc(data.expiresAt),
    scopes: 'user:profile user:inference user:sessions:claude_code user:mcp_servers',
    ...typeof data.emailAddress === 'string' ? { emailAddress: data.emailAddress } : {},
    ...typeof data.subscriptionType === 'string' ? { subscriptionType: data.subscriptionType } : {},
  }
}

function readFromKeychain(): ClaudeSession | undefined {
  try {
    const raw = execSync(`/usr/bin/security find-generic-password -s "${PRIMARY_SERVICE}" -w`, {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return parseBlob(raw)
  } catch {
    return undefined
  }
}

function readFromFile(): ClaudeSession | undefined {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  try {
    const raw = readFileSync(join(configDir, '.credentials.json'), 'utf8')
    return parseBlob(raw)
  } catch {
    return undefined
  }
}

export function readClaudeCodeCredentials(): ClaudeSession | undefined {
  if (process.platform === 'darwin') {
    const session = readFromKeychain()
    if (session) return session
  }
  return readFromFile()
}
