import { ChunkType } from '@renderer/types/chunk'
import { describe, expect, it, vi } from 'vitest'

import { createStreamProcessor } from '../StreamProcessingService'

describe('createStreamProcessor request lifecycle', () => {
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
