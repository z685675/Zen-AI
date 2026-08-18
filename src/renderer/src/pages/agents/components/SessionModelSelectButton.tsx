import { markAgentDefaultPolicyApplied } from '@renderer/config/agentModelPolicy'
import { useAgent } from '@renderer/hooks/agents/useAgent'
import { useUpdateAgent } from '@renderer/hooks/agents/useUpdateAgent'
import { useUpdateSession } from '@renderer/hooks/agents/useUpdateSession'
import { selectNewTopicLoading } from '@renderer/hooks/useMessageOperations'
import { useAppSelector } from '@renderer/store'
import type { ApiModel, GetAgentSessionResponse } from '@renderer/types'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import type { ComponentProps } from 'react'
import { useCallback } from 'react'

import SelectAgentBaseModelButton from './SelectAgentBaseModelButton'

type Props = Omit<ComponentProps<typeof SelectAgentBaseModelButton>, 'agentBase' | 'onSelect' | 'isDisabled'> & {
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
  const { updateAgent } = useUpdateAgent()
  const { updateModel: updateSessionModel } = useUpdateSession(agentId)
  const topicId = buildAgentSessionTopicId(session.id)
  const taskRunning = useAppSelector((state) => selectNewTopicLoading(state, topicId))
  const modelPolicy = useAppSelector((state) => state.llm.modelPolicy)

  const handleSelect = useCallback(
    async (model: ApiModel) => {
      const updatedSession = await updateSessionModel(session.id, model.id, { showSuccessToast: false })
      if (!updatedSession || !persistAsDefault) return

      await updateAgent(
        {
          id: agentId,
          model: model.id,
          ...(agent
            ? {
                configuration: markAgentDefaultPolicyApplied(agent.configuration, modelPolicy)
              }
            : {})
        },
        { showSuccessToast: false }
      )
    },
    [agent, agentId, modelPolicy, persistAsDefault, session.id, updateAgent, updateSessionModel]
  )

  return (
    <SelectAgentBaseModelButton
      {...buttonProps}
      agentBase={session}
      onSelect={handleSelect}
      isDisabled={isDisabled || taskRunning}
    />
  )
}

export default SessionModelSelectButton
