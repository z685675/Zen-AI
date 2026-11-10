import type { DshPreviewStatus } from '@shared/dshPreview'
import { useEffect, useSyncExternalStore } from 'react'

let snapshot: DshPreviewStatus | null = null
let refresh: Promise<void> | undefined
let revision = 0
const listeners = new Set<() => void>()

export function publishDshPreviewStatus(status: DshPreviewStatus): void {
  revision++
  snapshot = status
  for (const listener of listeners) listener()
}

export function refreshDshPreviewStatus(): Promise<void> {
  if (!window.api?.internalTesting?.status) {
    publishDshPreviewStatus({ unlocked: false, version: '', state: 'not-installed' })
    return Promise.resolve()
  }
  if (!refresh) {
    const requestedAt = revision
    refresh = window.api.internalTesting
      .status()
      .then((status) => {
        // Unlock/lock events take precedence over an older in-flight poll.
        if (revision === requestedAt) publishDshPreviewStatus(status)
      })
      .finally(() => {
        refresh = undefined
      })
  }
  return refresh
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  const unsubscribe = window.api?.internalTesting?.onChanged?.(publishDshPreviewStatus)
  return () => {
    listeners.delete(listener)
    unsubscribe?.()
  }
}

export function useDshPreviewStatus(): DshPreviewStatus | null {
  const status = useSyncExternalStore(subscribe, () => snapshot)
  useEffect(() => {
    void refreshDshPreviewStatus().catch(() => {
      // A missing main-process bridge must never expose an experimental entry.
      publishDshPreviewStatus({ unlocked: false, version: '', state: 'not-installed' })
    })
  }, [])
  return status
}
