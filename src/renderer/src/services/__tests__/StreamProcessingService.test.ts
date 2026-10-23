import { ChunkType } from '@renderer/types/chunk'
import { describe, expect, it, vi } from 'vitest'

import { createStreamProcessor } from '../StreamProcessingService'

describe('createStreamProcessor request lifecycle', () => {
  it('drains buffered callbacks before the owner disposes its request', async () => {
    let active = true
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const onTextChunk = vi.fn()
    const onComplete = vi.fn()
    const process = createStreamProcessor(
      { onRawData: () => blocked, onTextChunk, onComplete },
      { isActive: () => active }
    )
    void process({ type: ChunkType.RAW, content: { type: 'opencode_status' } })
    void process({ type: ChunkType.TEXT_DELTA, text: '完整正文' })
    void process({ type: ChunkType.LLM_RESPONSE_COMPLETE })
    let drained = false
    const finished = process.drain().then(() => {
      drained = true
      active = false
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(onTextChunk).not.toHaveBeenCalled()
    release()
    await finished
    expect(onTextChunk).toHaveBeenCalledWith('完整正文', undefined)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(active).toBe(false)
  })
  it('ignores chunks from a superseded request', async () => {
    let active = true
    const onTextChunk = vi.fn()
    const process = createStreamProcessor({ onTextChunk }, { isActive: () => active })

    await process({ type: ChunkType.TEXT_DELTA, text: 'first' })
    expect(onTextChunk).toHaveBeenCalledWith('first', undefined)

    active = false
    await process({ type: ChunkType.TEXT_DELTA, text: 'stale' })

    expect(onTextChunk).toHaveBeenCalledTimes(1)
  })

  it('notifies the stream callback once when aborted and ignores later chunks', async () => {
    const controller = new AbortController()
    const onError = vi.fn()
    const onTextChunk = vi.fn()
    const process = createStreamProcessor(
      { onError, onTextChunk },
      { signal: controller.signal, isActive: () => !controller.signal.aborted }
    )

    controller.abort()
    await process({ type: ChunkType.TEXT_DELTA, text: 'stale' })

    expect(onError).toHaveBeenCalledTimes(0)
    expect(onTextChunk).not.toHaveBeenCalled()
  })

  it('notifies the active request when aborted', async () => {
    const controller = new AbortController()
    const onError = vi.fn()
    const process = createStreamProcessor({ onError }, { signal: controller.signal })

    controller.abort()
    await Promise.resolve()
    await process({ type: ChunkType.TEXT_DELTA, text: 'ignored' })

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toMatchObject({ name: 'AbortError' })
  })
})
