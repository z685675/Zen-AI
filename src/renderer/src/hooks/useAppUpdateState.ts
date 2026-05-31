import { useEffect, useState } from 'react'

export interface AppUpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
}

export interface AppUpdateProgressInfo {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface AppUpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error'
  source: 'auto' | 'manual'
  autoUpdateEnabled: boolean
  currentVersion: string
  updateInfo: AppUpdateInfo | null
  progress: AppUpdateProgressInfo | null
  latestVersion?: string
  message?: string
}

function mergeState(
  current: AppUpdateState,
  next: Partial<AppUpdateState> & { status: AppUpdateState['status'] }
): AppUpdateState {
  return {
    ...current,
    ...next,
    autoUpdateEnabled: next.autoUpdateEnabled ?? current.autoUpdateEnabled,
    currentVersion: next.currentVersion ?? current.currentVersion,
    updateInfo: next.updateInfo !== undefined ? next.updateInfo : current.updateInfo,
    progress: next.progress !== undefined ? next.progress : current.progress
  }
}

const initialState: AppUpdateState = {
  status: 'idle',
  source: 'auto',
  autoUpdateEnabled: true,
  currentVersion: '',
  updateInfo: null,
  progress: null
}

export function useAppUpdateState() {
  const [state, setState] = useState<AppUpdateState>(initialState)

  useEffect(() => {
    let mounted = true

    void window.api.getUpdateState().then((nextState: AppUpdateState) => {
      if (mounted) {
        setState(nextState)
      }
    })

    const removeAvailableListener = window.api.update.onAvailable((payload) => {
      setState((current) =>
        mergeState(current, {
          status: payload.status ?? 'available',
          source: payload.source,
          updateInfo: payload,
          progress: null
        })
      )
    })

    const removeDownloadedListener = window.api.update.onDownloaded((payload) => {
      setState((current) =>
        mergeState(current, {
          status: 'downloaded',
          source: payload.source,
          updateInfo: payload,
          progress: null
        })
      )
    })

    const removeProgressListener = window.api.update.onDownloadProgress((payload) => {
      setState((current) =>
        mergeState(current, {
          status: 'downloading',
          progress: payload
        })
      )
    })

    const removeNotAvailableListener = window.api.update.onNotAvailable((payload) => {
      setState((current) =>
        mergeState(current, {
          status: 'up-to-date',
          source: payload.source,
          latestVersion: payload.latestVersion,
          updateInfo: null,
          progress: null
        })
      )
    })

    const removeErrorListener = window.api.update.onError((payload) => {
      setState((current) =>
        mergeState(current, {
          status: 'error',
          source: payload.source,
          message: payload.message,
          progress: null
        })
      )
    })

    return () => {
      mounted = false
      removeAvailableListener()
      removeDownloadedListener()
      removeProgressListener()
      removeNotAvailableListener()
      removeErrorListener()
    }
  }, [])

  return {
    updateState: state,
    setUpdateState: setState
  }
}
