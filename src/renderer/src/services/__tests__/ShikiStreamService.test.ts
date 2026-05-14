import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { shikiStreamService } from '../ShikiStreamService'

describe('ShikiStreamService', () => {
  const language = 'typescript'
  const theme = 'one-light'

  beforeEach(() => {
    shikiStreamService.dispose()
  })

  afterEach(() => {
    shikiStreamService.dispose()
  })

  it('highlights code on the main thread when Worker is unavailable', async () => {
    const originalWorker = globalThis.Worker
    ;(globalThis as any).Worker = undefined

    const result = await shikiStreamService.highlightCodeChunk('const value = 1;', language, theme, 'caller-1')

    expect(shikiStreamService.hasWorkerHighlighter()).toBe(false)
    expect(result.lines.length).toBeGreaterThan(0)

    ;(globalThis as any).Worker = originalWorker
  })

  it('reuses tokenizer cache entries for the same caller and clears them on cleanup', async () => {
    const originalWorker = globalThis.Worker
    ;(globalThis as any).Worker = undefined

    await shikiStreamService.highlightCodeChunk('const a = 1;', language, theme, 'caller-1')
    await shikiStreamService.highlightCodeChunk('const b = 2;', language, theme, 'caller-1')

    expect((shikiStreamService as any).tokenizerCache.size).toBe(1)

    shikiStreamService.cleanupTokenizers('caller-1')

    expect((shikiStreamService as any).tokenizerCache.size).toBe(0)
    expect((shikiStreamService as any).codeCache.size).toBe(0)

    ;(globalThis as any).Worker = originalWorker
  })

  it('returns recall = -1 when a non-append update forces a reset', async () => {
    const originalWorker = globalThis.Worker
    ;(globalThis as any).Worker = undefined

    await shikiStreamService.highlightStreamingCode('const a = 1;', language, theme, 'caller-2')
    const result = await shikiStreamService.highlightStreamingCode('let a = 1;', language, theme, 'caller-2')

    expect(result.recall).toBe(-1)

    ;(globalThis as any).Worker = originalWorker
  })

  it('clears state on dispose', async () => {
    const originalWorker = globalThis.Worker
    ;(globalThis as any).Worker = undefined

    await shikiStreamService.highlightCodeChunk('const a = 1;', language, theme, 'caller-3')
    shikiStreamService.dispose()

    expect((shikiStreamService as any).worker).toBeNull()
    expect((shikiStreamService as any).highlighter).toBeNull()
    expect((shikiStreamService as any).tokenizerCache.size).toBe(0)
    expect((shikiStreamService as any).codeCache.size).toBe(0)

    ;(globalThis as any).Worker = originalWorker
  })

  it('is idempotent when disposed repeatedly', () => {
    expect(() => {
      shikiStreamService.dispose()
      shikiStreamService.dispose()
      shikiStreamService.dispose()
    }).not.toThrow()
  })
})
