import {
  fetchModelPerformance,
  type ModelPerformanceSnapshot,
  type ModelPerformanceWindow,
  type UsageErrorCode,
  type UsageSource,
  UsageStatisticsError
} from '@renderer/services/UsageStatisticsService'
import { useEffect, useState } from 'react'

type State = {
  source: UsageSource | undefined
  days: ModelPerformanceWindow
  data?: ModelPerformanceSnapshot
  error?: UsageErrorCode
  loading: boolean
}

export function useModelPerformance(source: UsageSource | undefined, days: ModelPerformanceWindow, revision: number) {
  const [state, setState] = useState<State>()
  useEffect(() => {
    if (!source) return
    const controller = new AbortController()
    let nextRefresh: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      setState((previous) => ({
        source,
        days,
        loading: true,
        data: previous?.source === source && previous.days === days ? previous.data : undefined
      }))
      try {
        const data = await fetchModelPerformance(source, days, controller.signal)
        if (!controller.signal.aborted) setState({ source, days, data, loading: false })
      } catch (error) {
        if (controller.signal.aborted) return
        const code = error instanceof UsageStatisticsError ? error.code : 'unavailable'
        setState({ source, days, error: code, loading: false })
        if (code === 'unsupported' || code === 'unauthorized') return
      }
      if (!controller.signal.aborted) nextRefresh = setTimeout(() => void load(), 60_000)
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(nextRefresh)
    }
  }, [source, days, revision])

  // A replacement credential must not display the previous key's data even
  // for the render before React cleans up its pending request.
  if (state?.source === source && state?.days === days) return state
  return { source, days, loading: Boolean(source) } satisfies State
}
