import { loggerService } from '@logger'
import { isAssistantModelAllowed } from '@renderer/config/agentModelPolicy'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import store, { useAppDispatch, useAppSelector } from '@renderer/store'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import { sendMessage } from '@renderer/store/thunk/messageThunk'
import type { Assistant } from '@renderer/types'
import { type Message, MessageBlockStatus } from '@renderer/types/newMessage'
import { extractAgentSessionIdFromTopicId } from '@renderer/utils/agentSession'
import { createMainTextBlock, createMessage } from '@renderer/utils/messageUtils/create'
import { isMessageProcessing } from '@renderer/utils/messageUtils/is'
import { normalizeAgentReasoningEffort, toAgentEffort } from '@renderer/utils/reasoningEffort'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { v4 as uuid } from 'uuid'

import { useAgentClient } from './agents/useAgentClient'

const logger = loggerService.withContext('NativeTaskContinuation')
// Two controls (error card and menubar) may refer to the same paused task.
const pendingTopics = new Set<string>()

function isLatestTurn(message: Message) {
  const state = store.getState()
  const messages = selectMessagesForTopic(state, message.topicId)
  return (
    messages.at(-1)?.id === message.id &&
    !messages.some(isMessageProcessing) &&
    !state.messages.loadingByTopic[message.topicId]
  )
}

/** Append a normal user turn to the SAME native session. Never rewind/retry history. */
export function useNativeTaskContinuation(message: Message) {
  const dispatch = useAppDispatch()
  const client = useAgentClient('opencode')
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const eligible = useAppSelector((state) => {
    const messages = selectMessagesForTopic(state, message.topicId)
    return (
      message.assistantId === DEFAULT_OPENCODE_AGENT_ID &&
      message.role === 'assistant' &&
      !message.providerMetadata?.legacyContinuation &&
      messages.at(-1)?.id === message.id &&
      !messages.some(isMessageProcessing) &&
      !state.messages.loadingByTopic[message.topicId]
    )
  })
  const continueTask = useCallback(async () => {
    if (!eligible || pendingTopics.has(message.topicId) || !isLatestTurn(message)) return
    pendingTopics.add(message.topicId)
    setSubmitting(true)
    try {
      const sessionId = extractAgentSessionIdFromTopicId(message.topicId)
      const session = await client.getSession(DEFAULT_OPENCODE_AGENT_ID, sessionId, { timeout: 5000 })
      if (!isLatestTurn(message)) return
      const separator = session.model.indexOf(':')
      const currentState = store.getState()
      const provider = currentState.llm.providers.find((p) => p.enabled && p.id === session.model.slice(0, separator))
      const model =
        separator > 0 ? provider?.models.find((m) => m.id === session.model.slice(separator + 1)) : undefined
      if (
        !model ||
        !isAssistantModelAllowed(
          { id: `${model.provider}:${model.id}`, provider_model_id: model.id, name: model.name },
          currentState.settings.enableDeveloperMode,
          currentState.llm.modelPolicy?.policy
        )
      ) {
        window.toast.warning(t('agent.modelPolicy.noFallback'))
        return
      }
      const assistant: Assistant = {
        id: DEFAULT_OPENCODE_AGENT_ID,
        name: session.name ?? t('agent.errorFallback.assistant_name'),
        prompt: session.instructions ?? '',
        topics: [],
        type: 'agent-session',
        model,
        defaultModel: model,
        settings: {},
        tags: [],
        enableWebSearch: false
      }
      const id = uuid()
      const block = createMainTextBlock(id, t('assistantTaskContinuation.prompt'), {
        status: MessageBlockStatus.SUCCESS
      })
      const user = createMessage('user', message.topicId, assistant.id, {
        id,
        blocks: [block.id],
        model,
        modelId: model.id
      })
      await dispatch(
        sendMessage(user, [block], assistant, message.topicId, {
          agentId: assistant.id,
          sessionId,
          effort: toAgentEffort(normalizeAgentReasoningEffort(session.configuration?.reasoning_effort))
        })
      )
      void EventEmitter.emit(EVENT_NAMES.SEND_MESSAGE, { topicId: message.topicId })
    } catch (error) {
      logger.warn('Could not continue the native task', error as Error)
      window.toast.error(t('assistantTaskContinuation.failed'))
    } finally {
      pendingTopics.delete(message.topicId)
      setSubmitting(false)
    }
  }, [client, dispatch, eligible, message, t])
  return { canContinue: eligible && !submitting, submitting, continueTask }
}
