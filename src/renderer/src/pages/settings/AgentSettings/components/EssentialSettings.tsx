import { useAgentWorkspace } from '@renderer/context/AgentWorkspaceProvider'
import { Alert } from 'antd'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import { type AgentOrSessionSettingsProps, SettingsContainer } from '../shared'
import { AccessibleDirsSetting } from './AccessibleDirsSetting'
import { DescriptionSetting } from './DescriptionSetting'
import { HeartbeatSetting } from './HeartbeatSetting'
import { ModelSetting } from './ModelSetting'
import { NameSetting } from './NameSetting'
import { SoulModeSetting } from './SoulModeSetting'

type EssentialSettingsProps = AgentOrSessionSettingsProps & {
  showModelSetting?: boolean
}

const EssentialSettings: FC<EssentialSettingsProps> = ({ agentBase, update, showModelSetting = true }) => {
  const workspace = useAgentWorkspace()
  const { t } = useTranslation()
  if (!agentBase) return null

  return (
    <SettingsContainer>
      <NameSetting base={agentBase} update={update} />
      {showModelSetting && <ModelSetting base={agentBase} update={update} />}
      <AccessibleDirsSetting base={agentBase} update={update} />
      {workspace === 'legacy' && <SoulModeSetting base={agentBase} update={update} />}
      {workspace === 'legacy' && <HeartbeatSetting base={agentBase} update={update} />}
      <DescriptionSetting base={agentBase} update={update} />
      {workspace === 'opencode' && <Alert type="info" showIcon message={t('assistantProduct.searchDisclosure')} />}
    </SettingsContainer>
  )
}

export default EssentialSettings
