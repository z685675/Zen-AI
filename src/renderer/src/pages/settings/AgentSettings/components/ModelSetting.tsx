import { HelpTooltip } from '@renderer/components/TooltipIcons'
import { selectNewTopicLoading } from '@renderer/hooks/useMessageOperations'
import SelectAgentBaseModelButton from '@renderer/pages/agents/components/SelectAgentBaseModelButton'
import { useAppSelector } from '@renderer/store'
import type { AgentBaseWithId, ApiModel, UpdateAgentFunctionUnion } from '@renderer/types'
import { isAgentEntity, isAgentSessionEntity } from '@renderer/types'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { useTranslation } from 'react-i18next'

import { SettingsItem, SettingsTitle } from '../shared'

export interface ModelSettingProps {
  base: AgentBaseWithId | undefined | null
  update: UpdateAgentFunctionUnion
  isDisabled?: boolean
}

export const ModelSetting = ({ base, update, isDisabled }: ModelSettingProps) => {
  const { t } = useTranslation()
  const sessionTopicId = base && isAgentSessionEntity(base) ? buildAgentSessionTopicId(base.id) : null
  const taskRunning = useAppSelector((state) => (sessionTopicId ? selectNewTopicLoading(state, sessionTopicId) : false))

  const updateModel = async (model: ApiModel) => {
    if (!base) return
    return update({ id: base.id, model: model.id })
  }

  if (!base) return null
  const isAgentDefault = isAgentEntity(base)
  const label = isAgentDefault ? t('agent.settings.model.defaultLabel') : t('common.model')
  const tooltip = isAgentDefault ? t('agent.settings.model.defaultTooltip') : t('agent.settings.model.sessionTooltip')

  return (
    <SettingsItem inline>
      <SettingsTitle id="model" contentAfter={<HelpTooltip title={tooltip} />}>
        {label}
      </SettingsTitle>
      <SelectAgentBaseModelButton
        agentBase={base}
        onSelect={async (model) => {
          await updateModel(model)
        }}
        isDisabled={isDisabled || taskRunning}
      />
    </SettingsItem>
  )
}
