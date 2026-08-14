/**
 * `image_generate` tool: generate images through the ChatGPT/Codex
 * subscription's image endpoint, save them as PNG files under the harness
 * home, and — when the deployment mounts an attachment store and the calling
 * route declares image input — also commit the bytes as durable attachments
 * so the images render inline and enter model context (the same path
 * `read_image` uses). Mirrors codex-rs `codex-api/src/images.rs`: POST
 * `/backend-api/codex/images/generations` with the responses call's auth
 * headers; the response carries base64 PNG data.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
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
  /** Lazy attachment-store lookup; absent or unmounted store keeps the text-only result. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Lazy llm-service lookup for the image-capability route check. */
  resolveLlm?: () => LlmRuntime | undefined
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
 * Non-throwing image-capability check for the calling route (read_image's
 * gate, softened: a generated image that cannot enter history degrades to the
 * text-only result instead of failing the call). Resolves the session's
 * latest routed provider/model and answers whether the exact route declares
 * image input; any resolution failure means "no".
 */
async function routeDeclaresImageInput(
  resolveLlm: (() => LlmRuntime | undefined) | undefined,
  exec: ToolExecution,
): Promise<boolean> {
  const llm = resolveLlm?.()
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  if (llm === undefined || provider === undefined || model === undefined) return false
  try {
    const active = await llm.resolveModelInfo(provider, model, exec.signal)
    return active.inputModalities?.includes('image') === true
  } catch {
    // An unresolvable route cannot be proven image-capable: degrade to text.
    return false
  }
}

/** Canonical image metadata as the output schema declares it. */
interface ImageGenerateImageValue {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
}

/** The canonical output value of one successful generation. */
interface ImageGenerateValue {
  paths: string[]
  images?: ImageGenerateImageValue[]
  revisedPrompt?: string
}

/** Re-brand one canonical image entry into the attachment reference an ImageBlock carries. */
function imageRefFromValue(image: ImageGenerateImageValue): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

/** Project the canonical value into the model-facing text + image blocks. */
function imageGenerateContent(value: ImageGenerateValue): ContentBlock[] {
  return [
    imageGenerateText(value),
    ...(value.images ?? []).map(image => ({ type: 'image' as const, attachment: imageRefFromValue(image) })),
  ]
}

/** The text summary of one generation, shared by the model content and the UI card. */
function imageGenerateText(value: ImageGenerateValue): ContentBlock {
  const text = `Saved ${value.paths.length} image(s):\n${value.paths.map(path => `- ${path}`).join('\n')}`
    + (value.revisedPrompt === undefined ? '' : `\n\nRevised prompt: ${value.revisedPrompt}`)
  return { type: 'text', text }
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
      + 'Returns the saved file paths; on image-capable models the image itself is attached.',
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
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                name: { type: 'string' },
              },
            },
          },
          revisedPrompt: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => imageGenerateContent(value),
    },
    presentCall: args => ({
      card: 'generic',
      title: `image_generate: ${truncate(args.prompt)}`,
    }),
    // The web UI has no image surface on tool cards and flattens result blocks
    // to text/JSON, so the completed card shows the text summary only; the
    // image block stays model-facing in the render output.
    presentResult: (_args, result) => ({
      card: 'generic' as const,
      content: result.content.filter(block => block.type === 'text'),
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

      // Inline display requires durable attachment references, and those may
      // only enter session history on a route that declares image input.
      // Either condition failing degrades to the text-only result.
      const attachments = options.resolveAttachments?.()
      const imageCapable = attachments !== undefined
        && await routeDeclaresImageInput(options.resolveLlm, exec)
      const refs: ImageGenerateImageValue[] = []
      if (attachments !== undefined && imageCapable) {
        for (const [index, image] of images.entries()) {
          const ref = await attachments.saveImage({
            data: image.data,
            mediaType: 'image/png',
            name: basename(paths[index]),
          })
          refs.push({
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...ref.name === undefined ? {} : { name: ref.name },
          })
        }
      }

      const revisedPrompt = images.find(image => image.revisedPrompt !== undefined)?.revisedPrompt
      const value: ImageGenerateValue = {
        paths,
        ...refs.length > 0 ? { images: refs } : {},
        ...revisedPrompt === undefined ? {} : { revisedPrompt },
      }
      // Nested (Code Mode) dispatches have no card: defer the image content as
      // a user message so the next model request still sees it (read_image's
      // pattern).
      if (exec.parent !== undefined && refs.length > 0) {
        exec.deferContext(createUserMessage({
          content: imageGenerateContent(value),
          source: { kind: 'plugin', plugin: 'dsh-plugin-subscriptions' },
        }))
      }
      return value
    },
  })
}
