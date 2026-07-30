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
}

const SessionModelSelectButton = ({ agentId, session, isDisabled, ...buttonProps }: Props) => {
  const { updateModel } = useUpdateSession(agentId)
  const topicId = buildAgentSessionTopicId(session.id)
  const taskRunning = useAppSelector((state) => selectNewTopicLoading(state, topicId))

  const handleSelect = useCallback(
    async (model: ApiModel) => {
      await updateModel(session.id, model.id, { showSuccessToast: false })
    },
    [session.id, updateModel]
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
