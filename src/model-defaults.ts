/**
 * Per-model default reasoning effort overrides — the durable half of the
 * Settings page's per-model "default effort" pickers.
 *
 * The file lives at `~/.dsh/plugins/subscriptions/model-defaults.json`
 * (mode 0600, atomic replace). Shape: `{ "<provider>": { "<model id>": "<effort>" } }`.
 * An absent entry means "follow the provider's own default": the `Default`
 * chip the model picker shows when the discovered catalog advertises no
 * default at all.
 *
 * Writes are single-process (the Settings page issues them one at a time)
 * and every read comes from the in-memory snapshot, so the on-disk file only
 * needs to survive a restart: a malformed file reads as empty and is
 * rewritten on the next save, never taking the plugin down with it.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { PROVIDER_IDS, type ProviderId } from './auth/store.js'

/** One model id → its configured default reasoning effort id. */
export type ModelDefaultMap = Readonly<Record<string, string>>
/** Provider route → model defaults. */
export type ModelDefaults = Readonly<Partial<Record<ProviderId, ModelDefaultMap>>>

/** Absolute path of the defaults file. */
export function modelDefaultsFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'model-defaults.json')
}

const EMPTY: ModelDefaults = Object.freeze({})
/** In-memory snapshot read by every consumer (adapters, RPC). */
let current: ModelDefaults = EMPTY
/** One lazy load of the on-disk file (read once per process). */
let ready: Promise<void> | undefined
/** Last load failure, surfaced to callers that care; defaults stay empty. */
let loadError: unknown

/** Validate one persisted provider section: a string→string map, or undefined. */
function sanitizeProvider(value: unknown): ModelDefaultMap | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries: Record<string, string> = {}
  for (const [model, effort] of Object.entries(value)) {
    // Drop the whole section on the first malformed entry: a half-usable map
    // would silently un-default models the user did configure.
    if (typeof effort !== 'string' || effort.length === 0) return undefined
    entries[model] = effort
  }
  if (Object.keys(entries).length === 0) return undefined
  return Object.freeze(entries)
}

/** Validate the raw document: only known providers, malformed sections dropped. */
function sanitizeDefaults(value: unknown): ModelDefaults {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return EMPTY
  const record = value as Record<string, unknown>
  const result: Partial<Record<ProviderId, ModelDefaultMap>> = {}
  for (const provider of PROVIDER_IDS) {
    const section = sanitizeProvider(record[provider])
    if (section !== undefined) result[provider] = section
  }
  return Object.freeze(result)
}

/** Read and validate the on-disk file; a missing or malformed file reads as empty. */
async function loadFile(path: string): Promise<ModelDefaults> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY
    throw error
  }
  try {
    return sanitizeDefaults(JSON.parse(text))
  } catch {
    throw new Error(`subscriptions model defaults at ${path} are not valid JSON; fix or delete the file`)
  }
}

/** Resolve the module state once from disk; failures leave the defaults empty. */
async function ensureReady(): Promise<void> {
  ready ??= loadFile(modelDefaultsFilePath()).then(
    (loaded) => {
      current = loaded
      loadError = undefined
    },
    (error) => {
      loadError = error
      current = EMPTY
    },
  )
  return ready
}

/** Persist a snapshot atomically with owner-only permissions. */
async function persistDefaults(defaults: ModelDefaults, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify(defaults, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** Clone one provider section, or undefined when nothing is configured for it. */
function sectionOf(defaults: ModelDefaults, provider: ProviderId): ModelDefaultMap | undefined {
  const section = defaults[provider]
  if (section === undefined) return undefined
  return { ...section }
}

/**
 * Ready the defaults store.
 * @internal Exported for tests; index.ts calls it at apply time so every
 * later synchronous read sees the persisted state.
 */
export async function loadModelDefaults(): Promise<void> {
  await ensureReady()
}

/** The last load failure, when any; consumers only use it for diagnostics. */
export function modelDefaultsLoadError(): unknown {
  return loadError
}

/**
 * The configured default effort for one model, or undefined when none (the
 * picker then follows the provider's own default).
 * @internal Exported for the adapters' `defaultEffortOf` options.
 */
export function defaultEffortOf(provider: ProviderId, model: string): string | undefined {
  const section = current[provider]
  if (section === undefined) return undefined
  // Own-property lookup: a model id is provider-supplied catalog data, and a
  // plain index would inherit from Object.prototype for names like
  // `toString`, handing a *function* to mergeReasoning (which then throws and
  // breaks that model's resolution).
  return Object.prototype.hasOwnProperty.call(section, model) ? section[model] : undefined
}

/** A detached snapshot for the RPC surface (render + diffing). */
export function modelDefaultsSnapshot(): ModelDefaults {
  const result: Partial<Record<ProviderId, ModelDefaultMap>> = {}
  for (const provider of PROVIDER_IDS) {
    const section = sectionOf(current, provider)
    if (section !== undefined) result[provider] = section
  }
  return Object.freeze(result)
}

/**
 * Set or clear one model's configured default effort, then persist. The
 * memory snapshot updates only after the atomic write succeeds, so a failed
 * write never leaves the live state ahead of the file.
 * @param provider - the subscription provider route.
 * @param model - the wire model id.
 * @param effort - the effort id, or undefined to clear the override.
 */
export async function setDefaultEffort(
  provider: ProviderId,
  model: string,
  effort: string | undefined,
): Promise<void> {
  await ensureReady()
  const section = { ...sectionOf(current, provider) ?? {} }
  if (effort === undefined) {
    delete section[model]
  } else {
    section[model] = effort
  }
  const next: Partial<Record<ProviderId, ModelDefaultMap>> = { ...current }
  if (Object.keys(section).length === 0) {
    delete next[provider]
  } else {
    next[provider] = Object.freeze(section)
  }
  const frozen = Object.freeze(next)
  await persistDefaults(frozen, modelDefaultsFilePath())
  current = frozen
}

/**
 * Drop the in-memory state and the cached load. Test-only: lets a suite
 * unwind the lazy singleton before the next `loadModelDefaults`.
 * @internal Exported for tests only; not part of the plugin's public surface.
 */
export async function resetModelDefaultsForTests(): Promise<void> {
  current = EMPTY
  ready = undefined
  loadError = undefined
}
