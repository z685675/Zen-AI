import {
  fetchUsageStatistics,
  type UsageErrorCode,
  type UsageQuery,
  type UsageSource,
  type UsageStatistics,
  UsageStatisticsError
} from '@renderer/services/UsageStatisticsService'
import dayjs from 'dayjs'
import { useEffect, useState } from 'react'

interface UsageState {
  scope: string
  stats: UsageStatistics | null
  error: UsageErrorCode | null
  loading: boolean
  updatedAt: string | null
}

export function useUsageStatistics(source: UsageSource | undefined, query: UsageQuery, revision: number) {
  const apiHost = source?.apiHost
  const apiKey = source?.apiKey
  const supported = source?.supported
  const sourceID = source?.id
  const { start, end, timezone, scene } = query
  // In-memory only. A changed key/query must never show the preceding result,
  // even during the render before the effect cleans up its previous request.
  const scope = JSON.stringify([sourceID, apiHost, apiKey, supported, start, end, timezone, scene, revision])
  const [state, setState] = useState<UsageState | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const initial: UsageState = { scope, stats: null, error: null, loading: false, updatedAt: null }
    if (!apiHost || !apiKey) {
      setState(initial)
      return () => controller.abort()
    }
    if (!supported) {
      setState({ ...initial, error: 'unsupported' })
      return () => controller.abort()
    }
    setState({ ...initial, loading: true })
    void fetchUsageStatistics(
      { id: sourceID ?? '', label: '', apiHost, apiKey, supported },
      { start, end, timezone, scene },
      controller.signal
    )
      .then((stats) => {
        if (!controller.signal.aborted) setState({ ...initial, stats, updatedAt: dayjs().format('HH:mm:ss') })
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setState({ ...initial, error: reason instanceof UsageStatisticsError ? reason.code : 'unavailable' })
      })
    return () => controller.abort()
  }, [apiHost, apiKey, supported, sourceID, start, end, timezone, scene, scope])
  if (state?.scope === scope) return state
  return { scope, stats: null, error: null, loading: Boolean(apiHost && apiKey), updatedAt: null }
}
