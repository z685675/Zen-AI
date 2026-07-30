import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearContextTelemetry,
  getContextTelemetry,
  recordContextCache,
  recordContextCompression,
  recordContextRetrieval,
  recordContextRetry,
  setContextProcessingStatus
} from '../ContextTelemetryService'

const storage = new Map<string, unknown>()
Object.defineProperty(window, 'keyv', {
  configurable: true,
  value: {
    get: (key: string) => storage.get(key),
    set: (key: string, value: unknown) => storage.set(key, value),
    remove: (key: string) => storage.delete(key)
  }
})

describe('ContextTelemetryService', () => {
  beforeEach(() => {
    storage.clear()
  })

  it('persists processing progress and cumulative statistics', () => {
    setContextProcessingStatus('topic-1', 'extracting', '正在解析', { processedItems: 2, totalItems: 5 })
    recordContextCache('topic-1', true)
    recordContextCache('topic-1', false)
    recordContextCompression('topic-1', 'checkpoint-created')
    recordContextRetrieval('topic-1', 3)
    recordContextRetry('topic-1', 'adaptive-context-retry')

    expect(getContextTelemetry('topic-1')).toMatchObject({
      status: 'extracting',
      detail: '正在解析',
      processedItems: 2,
      totalItems: 5,
      cacheHits: 1,
      cacheMisses: 1,
      compressionCount: 1,
      retrievalCount: 1,
      retrievedChunks: 3,
      retryCount: 1
    })
  })

  it('clears telemetry without affecting another conversation', () => {
    recordContextCompression('topic-1', 'checkpoint-created')
    recordContextCompression('topic-2', 'checkpoint-created')

    clearContextTelemetry('topic-1')

    expect(getContextTelemetry('topic-1')?.compressionCount).toBe(0)
    expect(getContextTelemetry('topic-2')?.compressionCount).toBe(1)
  })
})
