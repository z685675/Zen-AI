import { loggerService } from '@logger'
import { isAssistantModelAllowed, markAgentDefaultPolicyApplied } from '@renderer/config/agentModelPolicy'
import { useAgent } from '@renderer/hooks/agents/useAgent'
import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import { useUpdateAgent } from '@renderer/hooks/agents/useUpdateAgent'
import { useUpdateSession } from '@renderer/hooks/agents/useUpdateSession'
import { selectNewTopicLoading } from '@renderer/hooks/useMessageOperations'
import { useAppSelector } from '@renderer/store'
import type { ApiModel, GetAgentSessionResponse } from '@renderer/types'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import type { ComponentProps } from 'react'
import { useCallback } from 'react'

import SelectAgentBaseModelButton from './SelectAgentBaseModelButton'

const logger = loggerService.withContext('SessionModelSelectButton')

type Props = Omit<
  ComponentProps<typeof SelectAgentBaseModelButton>,
  'agentBase' | 'onSelect' | 'isDisabled' | 'allowReselect'
> & {
  agentId: string
  session: GetAgentSessionResponse
  isDisabled?: boolean
  persistAsDefault?: boolean
}

const SessionModelSelectButton = ({
  agentId,
  session,
  isDisabled,
  persistAsDefault = false,
  ...buttonProps
}: Props) => {
  const { agent } = useAgent(agentId)
  const client = useAgentClient()
  const { updateAgent } = useUpdateAgent()
  const { updateModel: updateSessionModel } = useUpdateSession(agentId)
  const topicId = buildAgentSessionTopicId(session.id)
  const taskRunning = useAppSelector((state) => selectNewTopicLoading(state, topicId))
  const modelPolicy = useAppSelector((state) => state.llm.modelPolicy)
  const enableDeveloperMode = useAppSelector((state) => state.settings.enableDeveloperMode)

  const handleSelect = useCallback(
    async (model: ApiModel) => {
      if (session.model !== model.id) {
        const updatedSession = await updateSessionModel(session.id, model.id, { showSuccessToast: false })
        if (!updatedSession) return
      }

      let defaults = agent
      if (!persistAsDefault) {
        if (agentId !== DEFAULT_OPENCODE_AGENT_ID) return
        try {
          const [current, { data: models }] = await Promise.all([client.getAgent(agentId), client.getModels()])
          const policy = modelPolicy?.policy
          const available = models.filter((candidate) =>
            isAssistantModelAllowed(candidate, enableDeveloperMode, policy)
          )
          if (
            available.some((candidate) => candidate.id === current.model) ||
            !available.some((candidate) => candidate.id === model.id)
          ) {
            return
          }
          defaults = current
        } catch (error) {
          logger.warn('Failed to check the assistant default after switching the session model', error as Error)
          return
        }
      }

      await updateAgent(
        {
          id: agentId,
          model: model.id,
          ...(defaults
            ? {
                configuration: markAgentDefaultPolicyApplied(defaults.configuration, modelPolicy)
              }
            : {})
        },
        { showSuccessToast: false }
      )
    },
    [
      agent,
      agentId,
      client,
      enableDeveloperMode,
      modelPolicy,
      persistAsDefault,
      session.id,
      session.model,
      updateAgent,
      updateSessionModel
    ]
  )

  return (
    <SelectAgentBaseModelButton
      {...buttonProps}
      agentBase={session}
      onSelect={handleSelect}
      isDisabled={isDisabled || taskRunning}
      allowReselect={agentId === DEFAULT_OPENCODE_AGENT_ID && agent?.model !== session.model}
    />
  )
}

export default SessionModelSelectButton
