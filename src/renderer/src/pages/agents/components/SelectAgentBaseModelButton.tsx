import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { SelectAgentModelPopup } from '@renderer/components/Popups/SelectModelPopup'
import { isAssistantModelAllowed } from '@renderer/config/agentModelPolicy'
import { agentModelFilter } from '@renderer/config/models'
import { useApiModel } from '@renderer/hooks/agents/useModel'
import { useEnableDeveloperMode } from '@renderer/hooks/useSettings'
import { getProviderNameById } from '@renderer/services/ProviderService'
import { useAppSelector } from '@renderer/store'
import type { AgentBaseWithId, ApiModel } from '@renderer/types'
import { isAgentSessionEntity } from '@renderer/types'
import { isAgentEntity } from '@renderer/types'
import { getModelFilterByAgentType } from '@renderer/utils/agentSession'
import { apiModelAdapter } from '@renderer/utils/model'
import type { ButtonProps } from 'antd'
import { Button } from 'antd'
import { ChevronsUpDown } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  agentBase: AgentBaseWithId
  onSelect: (model: ApiModel) => Promise<void>
  isDisabled?: boolean
  allowReselect?: boolean
  /** Custom className for the button */
  className?: string
  /** Custom inline styles for the button (merged with default styles) */
  buttonStyle?: CSSProperties
  /** Custom button size */
  buttonSize?: ButtonProps['size']
  /** Custom avatar size */
  avatarSize?: number
  /** Custom font size */
  fontSize?: number
  /** Custom icon size */
  iconSize?: number
  /** Custom className for the inner container (e.g., for justify-between) */
  containerClassName?: string
}

const SelectAgentBaseModelButton = ({
  agentBase: agent,
  onSelect,
  isDisabled,
  allowReselect = false,
  className,
  buttonStyle,
  buttonSize = 'small',
  avatarSize = 16,
  fontSize = 12.5,
  iconSize = 13,
  containerClassName
}: Props) => {
  const { t } = useTranslation()
  const { enableDeveloperMode } = useEnableDeveloperMode()
  const modelPolicy = useAppSelector((state) => state.llm.modelPolicy)
  const [isUpdating, setIsUpdating] = useState(false)
  const model = useApiModel({ id: agent?.model })

  const apiFilter = isAgentEntity(agent)
    ? getModelFilterByAgentType(agent.type, agent.configuration)
    : isAgentSessionEntity(agent)
      ? getModelFilterByAgentType(agent.agent_type, agent.configuration)
      : undefined
  if (!agent) return null

  const onSelectModel = async () => {
    const selectedModel = await SelectAgentModelPopup.show({
      model,
      apiFilter: apiFilter,
      apiModelFilter: (candidate) => isAssistantModelAllowed(candidate, enableDeveloperMode, modelPolicy?.policy),
      modelFilter: agentModelFilter
    })
    if (selectedModel && (allowReselect || selectedModel.id !== agent.model)) {
      setIsUpdating(true)
      try {
        await onSelect(selectedModel)
      } finally {
        setIsUpdating(false)
      }
    }
  }

  const providerName = model?.provider ? getProviderNameById(model.provider) : model?.provider_name

  // Merge default styles with custom styles
  const mergedStyle: CSSProperties = {
    borderRadius: 'var(--zen-radius-pill)',
    height: 35,
    fontSize,
    padding: '0 14px 0 11px',
    background: 'var(--zen-glass-pill)',
    backdropFilter: 'blur(28px) saturate(170%)',
    border: 'none',
    boxShadow: 'var(--zen-shadow-pill)',
    ...buttonStyle
  }

  return (
    <Button
      size={buttonSize}
      type="text"
      className={className}
      style={mergedStyle}
      onClick={onSelectModel}
      disabled={isDisabled || isUpdating}
      loading={isUpdating}>
      <div className={containerClassName || 'flex max-w-[260px] items-center gap-2'}>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-hidden">
          <ModelAvatar model={model ? apiModelAdapter(model) : undefined} size={avatarSize} />
          <span className="truncate font-medium text-(--zen-text-1)">
            {model ? model.name : t('button.select_model')}
            {providerName ? <span className="font-normal text-(--zen-text-3)"> · {providerName}</span> : null}
          </span>
        </div>
        <ChevronsUpDown size={iconSize} color="var(--zen-text-3)" />
      </div>
    </Button>
  )
}

export default SelectAgentBaseModelButton
