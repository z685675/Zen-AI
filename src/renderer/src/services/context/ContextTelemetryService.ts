import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { ContextProcessingStatus, ContextTelemetry } from '@renderer/types'

const TELEMETRY_KEY_PREFIX = 'unified-context-telemetry:'

const telemetryKey = (conversationId: string) => `${TELEMETRY_KEY_PREFIX}${conversationId}`

const createTelemetry = (conversationId: string): ContextTelemetry => ({
  conversationId,
  status: 'idle',
  processedItems: 0,
  totalItems: 0,
  compressionCount: 0,
  retrievalCount: 0,
  retrievedChunks: 0,
  retryCount: 0,
  resourceCount: 0,
  cacheHits: 0,
  cacheMisses: 0,
  updatedAt: new Date().toISOString()
})

export function getContextTelemetry(conversationId?: string): ContextTelemetry | undefined {
  if (!conversationId || typeof window === 'undefined' || !window.keyv) {
    return undefined
  }
  const stored = window.keyv.get(telemetryKey(conversationId))
  return stored && typeof stored === 'object'
    ? { ...createTelemetry(conversationId), ...(stored as Partial<ContextTelemetry>), conversationId }
    : createTelemetry(conversationId)
}

export function updateContextTelemetry(
  conversationId: string,
  updates: Partial<Omit<ContextTelemetry, 'conversationId' | 'updatedAt'>>
): ContextTelemetry {
  const previous = getContextTelemetry(conversationId) ?? createTelemetry(conversationId)
  const telemetry: ContextTelemetry = {
    ...previous,
    ...updates,
    conversationId,
    updatedAt: new Date().toISOString()
  }
  if (typeof window !== 'undefined' && window.keyv) {
    window.keyv.set(telemetryKey(conversationId), telemetry)
  }
  void EventEmitter.emit(EVENT_NAMES.CONTEXT_STATUS_UPDATED, telemetry)
  return telemetry
}

export function setContextProcessingStatus(
  conversationId: string,
  status: ContextProcessingStatus,
  detail?: string,
  progress?: { processedItems?: number; totalItems?: number }
): ContextTelemetry {
  return updateContextTelemetry(conversationId, {
    status,
    detail,
    ...progress,
    ...(status !== 'error' ? { lastError: undefined } : {})
  })
}

export function recordContextCompression(conversationId: string, action: string): ContextTelemetry {
  const previous = getContextTelemetry(conversationId) ?? createTelemetry(conversationId)
  return updateContextTelemetry(conversationId, {
    compressionCount: previous.compressionCount + 1,
    lastAction: action
  })
}

export function recordContextRetrieval(conversationId: string, chunks: number): ContextTelemetry {
  const previous = getContextTelemetry(conversationId) ?? createTelemetry(conversationId)
  return updateContextTelemetry(conversationId, {
    retrievalCount: previous.retrievalCount + 1,
    retrievedChunks: previous.retrievedChunks + chunks,
    lastAction: chunks > 0 ? 'resource-retrieval' : previous.lastAction
  })
}

export function recordContextRetry(conversationId: string, action: string): ContextTelemetry {
  const previous = getContextTelemetry(conversationId) ?? createTelemetry(conversationId)
  return updateContextTelemetry(conversationId, {
    retryCount: previous.retryCount + 1,
    lastAction: action
  })
}

export function recordContextResourceCount(conversationId: string, resourceCount: number): ContextTelemetry {
  return updateContextTelemetry(conversationId, { resourceCount })
}

export function recordContextCache(conversationId: string, cacheHit: boolean): ContextTelemetry {
  const previous = getContextTelemetry(conversationId) ?? createTelemetry(conversationId)
  return updateContextTelemetry(conversationId, {
    cacheHits: previous.cacheHits + (cacheHit ? 1 : 0),
    cacheMisses: previous.cacheMisses + (cacheHit ? 0 : 1),
    lastAction: cacheHit ? 'cache-hit' : previous.lastAction
  })
}

export function markContextProcessingError(conversationId: string, error: unknown): ContextTelemetry {
  const message = error instanceof Error ? error.message : String(error)
  return updateContextTelemetry(conversationId, {
    status: 'error',
    detail: '上下文处理失败',
    lastError: message
  })
}

export function clearContextTelemetry(conversationId?: string): void {
  if (!conversationId || typeof window === 'undefined' || !window.keyv) {
    return
  }
  window.keyv.remove(telemetryKey(conversationId))
  void EventEmitter.emit(EVENT_NAMES.CONTEXT_STATUS_UPDATED, createTelemetry(conversationId))
}
