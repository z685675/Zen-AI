import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { publishDshPreviewStatus, refreshDshPreviewStatus, useDshPreviewStatus } from '../DshPreviewService'

describe('internal preview status', () => {
  it('does not let an older status poll reopen a freshly locked entry', async () => {
    let finish!: (value: any) => void
    const unsubscribe = vi.fn()
    window.api = {
      ...window.api,
      internalTesting: {
        status: vi.fn(
          () =>
            new Promise<any>((resolve) => {
              finish = resolve
            })
        ),
        onChanged: vi.fn(() => unsubscribe)
      }
    }
    const hook = renderHook(() => useDshPreviewStatus())
    act(() => publishDshPreviewStatus({ unlocked: false, state: 'not-installed', version: 'test' }))
    await act(async () => {
      finish({ unlocked: true, state: 'ready', version: 'test' })
      await refreshDshPreviewStatus()
    })
    expect(hook.result.current?.unlocked).toBe(false)
    hook.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
    window.api.internalTesting.status = vi.fn().mockResolvedValue({ unlocked: true, state: 'ready', version: 'test' })
    const fresh = renderHook(() => useDshPreviewStatus())
    await waitFor(() => expect(fresh.result.current?.state).toBe('ready'))
    fresh.unmount()
  })
})
