import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppUpdateState } from '../useAppUpdateState'

type UpdateAvailablePayload = {
  version: string
  currentVersion: string
  source: 'auto' | 'manual'
  status?: 'available' | 'downloading' | 'downloaded'
}

describe('useAppUpdateState', () => {
  let availableListener: ((payload: UpdateAvailablePayload) => void) | undefined
  let progressListener:
    | ((payload: { percent: number; transferred: number; total: number; bytesPerSecond: number }) => void)
    | undefined

  beforeEach(() => {
    availableListener = undefined
    progressListener = undefined

    ;(window as any).api = {
      getUpdateState: vi.fn().mockResolvedValue({
        status: 'idle',
        source: 'auto',
        autoUpdateEnabled: true,
        currentVersion: '1.0.0',
        updateInfo: null,
        progress: null
      }),
      update: {
        onAvailable: vi.fn((callback) => {
          availableListener = callback
          return vi.fn()
        }),
        onDownloaded: vi.fn(() => vi.fn()),
        onDownloadProgress: vi.fn((callback) => {
          progressListener = callback
          return vi.fn()
        }),
        onNotAvailable: vi.fn(() => vi.fn()),
        onError: vi.fn(() => vi.fn())
      }
    }
  })

  it('does not infer downloading from an auto available event without a downloading status', async () => {
    const { result } = renderHook(() => useAppUpdateState())

    await waitFor(() => {
      expect(result.current.updateState.status).toBe('idle')
    })

    act(() => {
      availableListener?.({
        version: '1.1.0',
        currentVersion: '1.0.0',
        source: 'auto',
        status: 'available'
      })
    })

    expect(result.current.updateState.status).toBe('available')

    act(() => {
      progressListener?.({
        percent: 10,
        transferred: 10,
        total: 100,
        bytesPerSecond: 0
      })
    })

    expect(result.current.updateState.status).toBe('downloading')
  })
  it('does not let an old initial snapshot overwrite live download progress', async () => {
    let finish!: (state: unknown) => void
    ;(window.api.getUpdateState as any).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const { result } = renderHook(() => useAppUpdateState())
    act(() => progressListener?.({ percent: 65, transferred: 65, total: 100, bytesPerSecond: 2 }))
    await act(async () => {
      finish({ status: 'available', source: 'auto', updateInfo: null })
      await Promise.resolve()
    })
    expect(result.current.updateState.status).toBe('downloading')
    expect(result.current.updateState.progress?.percent).toBe(65)
  })
})
