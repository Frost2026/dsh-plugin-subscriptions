/**
 * `image_generate` tool: generate images through the ChatGPT/Codex
 * subscription's image endpoint and save them as PNG files under the harness
 * home. Mirrors codex-rs `codex-api/src/images.rs`: POST
 * `/backend-api/codex/images/generations` with the responses call's auth
 * headers; the response carries base64 PNG data.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CodexSession } from '../auth/store.js'
import { httpLlmError, TokenManager } from '../providers/common.js'
import type { FetchFn } from '../providers/common.js'

/** Endpoint the generation request is posted to. */
export const IMAGE_GENERATE_URL = 'https://chatgpt.com/backend-api/codex/images/generations'
/** The image model the codex subscription endpoint serves. */
export const IMAGE_GENERATE_MODEL = 'gpt-image-2'

/** Dependencies of the `image_generate` tool. */
export interface ImageGenerateToolOptions {
  /** Codex session source; a missing session throws the log-in hint. */
  tokens: TokenManager<CodexSession>
  /** Fetch implementation (injectable for tests). */
  fetchFn?: FetchFn
  /** Directory override for saved images (defaults under the harness home). */
  imagesDir?: string
}

/** The wire request body for one generation call. */
export interface ImageGenerateRequestBody {
  prompt: string
  model: string
  size?: string
  quality?: string
}

/**
 * Assemble the request body from tool arguments (hand-checks the non-empty
 * prompt the schema DSL cannot express).
 */
export function buildImageGenerateBody(args: {
  prompt: string
  size?: '1024x1024' | '1024x1536' | '1536x1024' | 'auto'
  quality?: 'low' | 'medium' | 'high' | 'auto'
}): ImageGenerateRequestBody {
  const prompt = args.prompt.trim()
  if (prompt.length === 0) throw new Error('image_generate: prompt must be a non-empty string')
  return {
    prompt,
    model: IMAGE_GENERATE_MODEL,
    ...args.size === undefined ? {} : { size: args.size },
    ...args.quality === undefined ? {} : { quality: args.quality },
  }
}

/** One generated image decoded from the response. */
export interface GeneratedImage {
  /** PNG bytes. */
  data: Buffer
  /** Provider-revised prompt, when the response carries one. */
  revisedPrompt?: string
}

/**
 * Parse the generations response into decodable images. Throws when the
 * payload carries no usable `b64_json` entries.
 */
export function parseImageGenerateResponse(payload: unknown): GeneratedImage[] {
  const body = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const entries = Array.isArray(body.data) ? body.data : []
  const images: GeneratedImage[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.b64_json !== 'string' || record.b64_json.length === 0) continue
    images.push({
      data: Buffer.from(record.b64_json, 'base64'),
      ...typeof record.revised_prompt === 'string' && record.revised_prompt.length > 0
        ? { revisedPrompt: record.revised_prompt }
        : {},
    })
  }
  if (images.length === 0) throw new Error('image_generate: the response carried no image data')
  return images
}

/** Directory the generated PNG files are written to. */
export function imagesDirectory(): string {
  return dshHomePath('plugins', 'subscriptions', 'images')
}

/** Timestamped, collision-safe file name for one generated image. */
function imageFileName(index: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `image-${stamp}-${Math.random().toString(36).slice(2, 8)}-${index}.png`
}

/** Bound a call-card title's prompt. */
function truncate(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Build the `image_generate` tool definition.
 * @param options - codex session source, fetch implementation, and image directory.
 * @returns the tool to register on `ctx.tools`.
 */
export function createImageGenerateTool(options: ImageGenerateToolOptions): ToolDefinition {
  return defineTool({
    name: 'image_generate',
    description: 'Generate an image with the ChatGPT subscription (gpt-image-2) and save it as a PNG file. '
      + 'Returns the saved file paths.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the image should show.' },
      size: {
        type: 'string',
        enum: ['1024x1024', '1024x1536', '1536x1024', 'auto'],
        description: 'Image dimensions; omit for the provider default.',
      },
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'auto'],
        description: 'Rendering quality; omit for the provider default.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, required: true },
          revisedPrompt: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Saved ${value.paths.length} image(s):\n${value.paths.map(path => `- ${path}`).join('\n')}`
          + (value.revisedPrompt === undefined ? '' : `\n\nRevised prompt: ${value.revisedPrompt}`),
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `image_generate: ${truncate(args.prompt)}`,
    }),
    async execute(args, exec) {
      const body = buildImageGenerateBody(args)
      const session = await options.tokens.session()
      const response = await (options.fetchFn ?? fetch)(IMAGE_GENERATE_URL, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${session.accessToken}`,
          'chatgpt-account-id': session.accountId,
          'originator': 'codex_cli_rs',
          'content-type': 'application/json',
          'accept': 'application/json',
        },
        body: JSON.stringify(body),
        signal: exec.signal,
      })
      if (!response.ok) throw await httpLlmError(response, 'image_generate')
      const images = parseImageGenerateResponse(await response.json())
      const directory = options.imagesDir ?? imagesDirectory()
      await mkdir(directory, { recursive: true })
      const paths: string[] = []
      for (const [index, image] of images.entries()) {
        const path = join(directory, imageFileName(index))
        await writeFile(path, image.data)
        paths.push(path)
      }
      const revisedPrompt = images.find(image => image.revisedPrompt !== undefined)?.revisedPrompt
      return { paths, ...revisedPrompt === undefined ? {} : { revisedPrompt } }
    },
  })
}
