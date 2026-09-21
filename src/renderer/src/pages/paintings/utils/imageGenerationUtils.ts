import { GROK_IMAGINE_MAX_IMAGE_INPUTS } from '../config/NewApiConfig'

export const MAX_IMAGE_INPUTS = 6
export const MAX_GROK_IMAGINE_IMAGE_INPUTS = GROK_IMAGINE_MAX_IMAGE_INPUTS
export const MAX_IMAGE_PROMPT_LENGTH = 32_000
export const MAX_IMAGE_FILE_SIZE_BYTES = 20 * 1024 * 1024
export const MAX_IMAGE_TOTAL_SIZE_BYTES = 60 * 1024 * 1024

// GPT-image2 can take a long time for complex, high-resolution requests.
// Keep this above the documented two-minute worst case while still avoiding
// an indefinitely hanging UI.
export const IMAGE_GENERATION_REQUEST_TIMEOUT_MS = 150_000
export const MAX_IMAGE_GENERATION_RETRIES = 2

export const MAX_IMAGE_EDIT_PROMPT_LENGTH = MAX_IMAGE_PROMPT_LENGTH

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const RETRYABLE_IMAGE_RESPONSE_STATUSES = new Set([429, 500, 502, 503, 504])

export type ImageGenerationImageSource = {
  kind: 'base64' | 'url'
  value: string
}

export type GrokImagineImageRequestOptions = {
  model: string
  prompt: string
  n?: number
  aspectRatio?: string
  resolution?: string
  quality?: string
  imageDataUrls?: string[]
}

/**
 * Builds the native xAI Imagine request shape. Unlike the OpenAI-compatible
 * multipart edit format, xAI expects JSON and uses `image` for one reference
 * or `images` for multiple references.
 */
export function buildGrokImagineImageRequestBody({
  model,
  prompt,
  n = 1,
  aspectRatio,
  resolution = '1k',
  quality,
  imageDataUrls = []
}: GrokImagineImageRequestOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    prompt,
    n,
    resolution,
    response_format: 'url'
  }

  if (quality && quality !== 'auto') {
    body.quality = quality
  }

  if (imageDataUrls.length === 0) {
    body.aspect_ratio = aspectRatio || 'auto'
    return body
  }

  const images = imageDataUrls.map((url) => ({ url, type: 'image_url' }))
  if (images.length === 1) {
    body.image = images[0]
  } else {
    body.images = images
    if (aspectRatio && aspectRatio !== 'auto') {
      body.aspect_ratio = aspectRatio
    }
  }

  return body
}

export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Unable to read image data.'))
      }
    }
    reader.onerror = () => reject(reader.error || new Error('Unable to read image data.'))
    reader.readAsDataURL(file)
  })
}

type PaintingPromptMemory = {
  id: string
  prompt?: string
  basePrompt?: string
  sourcePaintingId?: string
}

/**
 * Finds the original creation description for an image-edit chain.
 *
 * New results persist `basePrompt`, but walking the source chain keeps old
 * paintings created before this field existed editable with useful context.
 */
export function resolvePaintingBasePrompt<T extends PaintingPromptMemory>(
  painting: T | undefined,
  paintings: ReadonlyArray<T>
): string | undefined {
  const visited = new Set<string>()
  let current = painting
  let fallbackPrompt: string | undefined

  while (current && !visited.has(current.id)) {
    visited.add(current.id)

    const basePrompt = current.basePrompt?.trim()
    if (basePrompt) {
      return basePrompt
    }

    const prompt = current.prompt?.trim()
    if (prompt) {
      fallbackPrompt = prompt
    }

    if (!current.sourcePaintingId) {
      return fallbackPrompt
    }

    const sourcePaintingId = current.sourcePaintingId
    current = paintings.find((candidate) => candidate.id === sourcePaintingId)
  }

  return fallbackPrompt
}

/**
 * Combines the retained creation description with only the current edit.
 * The full edit history is intentionally not appended, so prompts remain
 * bounded and contradictory historical instructions do not accumulate.
 */
export function composeImageEditPrompt(
  basePrompt: string | undefined,
  editPrompt: string,
  maxLength = MAX_IMAGE_EDIT_PROMPT_LENGTH
): string {
  const normalizedBasePrompt = basePrompt?.trim() ?? ''
  const normalizedEditPrompt = editPrompt.trim()

  if (!normalizedBasePrompt) {
    return normalizedEditPrompt.slice(0, maxLength)
  }

  const prefix = 'Original image description:\n'
  const separator = '\n\nEdit request (keep all unspecified details unchanged):\n'
  const availableBasePromptLength = Math.max(
    0,
    maxLength - prefix.length - separator.length - normalizedEditPrompt.length
  )
  const boundedBasePrompt = normalizedBasePrompt.slice(0, availableBasePromptLength)

  if (!boundedBasePrompt) {
    return normalizedEditPrompt.slice(0, maxLength)
  }

  return `${prefix}${boundedBasePrompt}${separator}${normalizedEditPrompt}`.slice(0, maxLength)
}

export class ImageGenerationResponseError extends Error {
  constructor(message = 'Image generation returned no usable images.') {
    super(message)
    this.name = 'ImageGenerationResponseError'
  }
}

export class ImageGenerationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Image generation request timed out after ${Math.round(timeoutMs / 1000)} seconds.`)
    this.name = 'ImageGenerationTimeoutError'
  }
}

export type ImageInputValidationIssue =
  | { code: 'unsupported_type'; fileName: string }
  | { code: 'empty_file'; fileName: string }
  | { code: 'file_too_large'; fileName: string; maxBytes: number }
  | { code: 'total_too_large'; maxBytes: number }

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

export function isSupportedImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  const mimeType = file.type.trim().toLowerCase()
  if (SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    return true
  }

  if (mimeType) {
    return false
  }

  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
  return SUPPORTED_IMAGE_EXTENSIONS.has(extension)
}

export function validateImageInputFiles(
  files: Array<Pick<File, 'name' | 'type' | 'size'>>
): ImageInputValidationIssue | null {
  let totalBytes = 0

  for (const file of files) {
    if (!isSupportedImageFile(file)) {
      return { code: 'unsupported_type', fileName: file.name }
    }
    if (file.size <= 0) {
      return { code: 'empty_file', fileName: file.name }
    }
    if (file.size > MAX_IMAGE_FILE_SIZE_BYTES) {
      return { code: 'file_too_large', fileName: file.name, maxBytes: MAX_IMAGE_FILE_SIZE_BYTES }
    }

    totalBytes += file.size
  }

  if (totalBytes > MAX_IMAGE_TOTAL_SIZE_BYTES) {
    return { code: 'total_too_large', maxBytes: MAX_IMAGE_TOTAL_SIZE_BYTES }
  }

  return null
}

/**
 * Extracts one usable image per response item while preserving response order.
 * GPT Image normally returns b64_json; URL handling remains for compatible
 * gateways. If a gateway returns both for the same item, prefer Base64 so the
 * same image is not saved twice.
 */
export function extractImageGenerationSources(payload: unknown): ImageGenerationImageSource[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new ImageGenerationResponseError('Image generation response did not contain a data array.')
  }

  const sources = payload.data.flatMap((item): ImageGenerationImageSource[] => {
    if (!isRecord(item)) {
      return []
    }

    const base64 = typeof item.b64_json === 'string' ? item.b64_json.trim() : ''
    if (base64) {
      return [{ kind: 'base64', value: base64 }]
    }

    const url = typeof item.url === 'string' ? item.url.trim() : ''
    return url ? [{ kind: 'url', value: url }] : []
  })

  if (sources.length === 0) {
    throw new ImageGenerationResponseError()
  }

  return sources
}

export function isRetryableImageResponse(response: Response): boolean {
  return RETRYABLE_IMAGE_RESPONSE_STATUSES.has(response.status)
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Image generation was cancelled', 'AbortError')
  }

  const error = new Error('Image generation was cancelled')
  error.name = 'AbortError'
  return error
}

function getRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(15_000, Math.max(500, seconds * 1000))
    }
  }

  return Math.min(8_000, 1_000 * 2 ** attempt)
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError())
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(createAbortError())
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function fetchImageGenerationRequest(
  input: RequestInfo | URL,
  init: RequestInit,
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    maxRetries?: number
    fetchFn?: typeof fetch
  } = {}
): Promise<Response> {
  const {
    signal,
    timeoutMs = IMAGE_GENERATION_REQUEST_TIMEOUT_MS,
    maxRetries = MAX_IMAGE_GENERATION_RETRIES,
    fetchFn = fetch
  } = options

  if (signal?.aborted) {
    throw createAbortError()
  }

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const requestController = new AbortController()
    let timedOut = false
    const onAbort = () => requestController.abort()
    const timeoutId = setTimeout(() => {
      timedOut = true
      requestController.abort()
    }, timeoutMs)

    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await fetchFn(input, {
        ...init,
        signal: requestController.signal
      })

      if (isRetryableImageResponse(response) && attempt < maxRetries) {
        try {
          await response.body?.cancel()
        } catch {
          // The response body is not needed for a retry.
        }
        await waitForRetry(getRetryDelayMs(response, attempt), signal)
        continue
      }

      return response
    } catch (error) {
      if (signal?.aborted) {
        throw createAbortError()
      }
      if (timedOut) {
        throw new ImageGenerationTimeoutError(timeoutMs)
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  throw new Error('Image generation request failed after retries.')
}
