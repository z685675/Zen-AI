import store, { useAppDispatch } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import { loadTopicMessagesThunk, renameAgentSessionIfNeeded } from '@renderer/store/thunk/messageThunk'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { useEffect } from 'react'

export function useSessionChanged(agentId: string | undefined, mutate: () => void) {
  const dispatch = useAppDispatch()

  useEffect(() => {
    const cleanup = window.api.agentSessionStream.onSessionChanged((data) => {
      if (agentId && data.agentId !== agentId) {
        return
      }

      mutate()
      if (data.reason === 'created') {
        return
      }

      const topicId = buildAgentSessionTopicId(data.sessionId)
      void renameAgentSessionIfNeeded(
        { agentId: data.agentId, sessionId: data.sessionId },
        topicId,
        store.getState
      ).then((renamed) => {
        if (renamed) {
          mutate()
        }
      })
      // Show fulfilled indicator (green dot) on the session item
      dispatch(
        newMessagesActions.setTopicFulfilled({
          topicId,
          fulfilled: true
        })
      )
      // Automation owns durable history, even while its display-only stream is watched.
      // A watched stream reloads after draining; do not replace its blocks mid-chunk.
      if (data.headless) {
        const state = store.getState().messages
        if (state.currentTopicId === topicId && !state.loadingByTopic[topicId]) {
          void dispatch(loadTopicMessagesThunk(topicId, true))
        }
      }
    })
    return cleanup
  }, [agentId, dispatch, mutate])
}
