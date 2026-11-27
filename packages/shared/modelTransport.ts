import { isZenManagedApiHost } from './config/zenProvider'

export const MODEL_TRANSPORT_IPC = {
  start: 'model-transport:start',
  pull: 'model-transport:pull',
  cancel: 'model-transport:cancel'
} as const

/** Restrict the privileged bridge to managed model APIs, never arbitrary browsing. */
export function isManagedModelRequest(url: string, method = 'GET'): boolean {
  try {
    const target = new URL(url)
    return (
      target.protocol === 'https:' &&
      !target.username &&
      !target.password &&
      (!target.port || target.port === '443') &&
      isZenManagedApiHost(target.href) &&
      ['GET', 'HEAD', 'POST'].includes(method.toUpperCase()) &&
      /^\/(?:v1\/(?:chat\/completions|completions|responses(?:\/compact)?|messages(?:\/count_tokens)?|models(?:\/[^/]+)?)|v1beta\/models(?:\/[^/]+)?|api\/status)\/?$/.test(
        target.pathname
      )
    )
  } catch {
    return false
  }
}

export interface ModelTransportRequest {
  id: string
  url: string
  method: string
  headers: [string, string][]
  body?: string
}

export interface ModelTransportError {
  name: string
  message: string
  code?: string
}

export type ModelTransportStart =
  | { ok: true; status: number; statusText: string; headers: [string, string][]; hasBody: boolean }
  | { ok: false; error: ModelTransportError }

export type ModelTransportChunk = { done: false; value: Uint8Array } | { done: true } | { error: ModelTransportError }

export interface ModelTransportBridge {
  start(request: ModelTransportRequest): Promise<ModelTransportStart>
  pull(id: string): Promise<ModelTransportChunk>
  cancel(id: string, reason?: 'timeout'): Promise<void>
}

export function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

export function transportError(error: unknown): ModelTransportError {
  const value = error as { name?: string; message?: string; code?: string; cause?: { code?: string } } | undefined
  return {
    name: value?.name || 'TypeError',
    message: value?.message || 'Failed to fetch',
    code: value?.cause?.code || value?.code
  }
}
