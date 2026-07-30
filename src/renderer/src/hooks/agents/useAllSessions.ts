import { DEFAULT_SESSION_PAGE_SIZE } from '@renderer/api/agent'
import type { ListAgentSessionsResponse, ListOptions, UpdateSessionForm } from '@renderer/types'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import useSWRInfinite from 'swr/infinite'

import { useAgentClient } from './useAgentClient'
import { useSessionChanged } from './useSessionChanged'

type UseAllSessionsOptions = {
  archived?: ListOptions['archived']
}

export const useAllSessions = (options: UseAllSessionsOptions = {}, pageSize = DEFAULT_SESSION_PAGE_SIZE) => {
  const { t } = useTranslation()
  const client = useAgentClient()
  const archived = options.archived ?? 'exclude'

  const getKey = (pageIndex: number, previousPageData: ListAgentSessionsResponse | null) => {
    if (previousPageData && previousPageData.data.length < pageSize) return null
    return [client.allSessionsPath, archived, pageIndex, pageSize]
  }

  const fetcher = async ([, archivedFilter, pageIndex, pageLimit]: [
    string,
    ListOptions['archived'],
    number,
    number
  ]) => {
    return await client.listAllSessions({
      limit: pageLimit,
      offset: pageIndex * pageLimit,
      archived: archivedFilter
    })
  }

  const { data, error, isLoading, isValidating, mutate, size, setSize } = useSWRInfinite(getKey, fetcher)

  const sessions = useMemo(() => {
    if (!data) return []
    return data.flatMap((page) => page.data)
  }, [data])

  const total = useMemo(() => {
    if (!data || data.length === 0) return 0
    return data[data.length - 1].total
  }, [data])
  const hasMore = sessions.length < total
  const isLoadingMore = isLoading || (size > 0 && data && typeof data[size - 1] === 'undefined')

  const loadMore = useCallback(() => {
    if (!isLoadingMore && hasMore) {
      void setSize((currentSize) => currentSize + 1)
    }
  }, [isLoadingMore, hasMore, setSize])

  const reload = useCallback(async () => {
    await mutate()
  }, [mutate])

  useSessionChanged(undefined, reload)

  const deleteSession = useCallback(
    async (agentId: string, sessionId: string): Promise<boolean> => {
      try {
        await client.deleteSession(agentId, sessionId)
        void mutate(
          (prev) => {
            if (!prev || prev.length === 0) return prev
            const newTotal = prev[0].total - 1
            return prev.map((page) => ({
              ...page,
              data: page.data.filter((session) => session.id !== sessionId),
              total: newTotal
            }))
          },
          { revalidate: false }
        )
        return true
      } catch (error) {
        window.toast.error(formatErrorMessageWithPrefix(error, t('agent.session.delete.error.failed')))
        return false
      }
    },
    [client, mutate, t]
  )

  const updateSession = useCallback(
    async (agentId: string, form: UpdateSessionForm) => {
      try {
        await client.updateSession(agentId, form)
        await mutate()
        return true
      } catch (error) {
        window.toast.error(formatErrorMessageWithPrefix(error, t('agent.session.update.error.failed')))
        return false
      }
    },
    [client, mutate, t]
  )

  return {
    sessions,
    total,
    hasMore,
    error,
    isLoading,
    isLoadingMore,
    isValidating,
    reload,
    loadMore,
    deleteSession,
    updateSession
  }
}
