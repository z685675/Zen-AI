import { ActionIconButton } from '@renderer/components/Buttons'
import {
  MdiLightbulbAutoOutline,
  MdiLightbulbOffOutline,
  MdiLightbulbOn,
  MdiLightbulbOn30,
  MdiLightbulbOn50,
  MdiLightbulbOn80,
  MdiLightbulbOn90,
  MdiLightbulbQuestion
} from '@renderer/components/Icons/SVGIcon'
import { QuickPanelReservedSymbol, useQuickPanel } from '@renderer/components/QuickPanel'
import { useAssistant } from '@renderer/hooks/useAssistant'
import type { ToolQuickPanelApi } from '@renderer/pages/home/Inputbar/types'
import type { Model, ThinkingOption } from '@renderer/types'
import {
  AGENT_DEFAULT_REASONING_EFFORT,
  AGENT_REASONING_EFFORT_OPTIONS,
  CHAT_REASONING_EFFORT_OPTIONS,
  normalizeChatReasoningEffort
} from '@renderer/utils/reasoningEffort'
import { Tooltip } from 'antd'
import { ChevronDown } from 'lucide-react'
import type { FC, ReactElement } from 'react'
import { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  quickPanel: ToolQuickPanelApi
  model: Model
  assistantId: string
  reasoningEffort?: ThinkingOption
  onReasoningEffortChange?: (option: ThinkingOption) => void
  variant?: 'chat' | 'agent'
}

const ThinkingButton: FC<Props> = ({
  quickPanel,
  assistantId,
  reasoningEffort: controlledEffort,
  onReasoningEffortChange,
  variant = 'chat'
}): ReactElement => {
  const { t } = useTranslation()
  const quickPanelHook = useQuickPanel()
  const isControlled = controlledEffort !== undefined
  const { assistant, updateAssistantSettings } = useAssistant(assistantId)
  const storedReasoningEffort = assistant.settings?.reasoning_effort

  const currentReasoningEffort = useMemo(() => {
    if (variant === 'agent') return controlledEffort ?? AGENT_DEFAULT_REASONING_EFFORT
    return normalizeChatReasoningEffort(storedReasoningEffort)
  }, [controlledEffort, storedReasoningEffort, variant])

  const supportedOptions = variant === 'agent' ? AGENT_REASONING_EFFORT_OPTIONS : CHAT_REASONING_EFFORT_OPTIONS

  useEffect(() => {
    if (variant !== 'chat' || isControlled || storedReasoningEffort === currentReasoningEffort) return

    updateAssistantSettings({
      reasoning_effort: currentReasoningEffort,
      reasoning_effort_cache: currentReasoningEffort,
      qwenThinkMode: currentReasoningEffort !== 'none'
    })
  }, [currentReasoningEffort, isControlled, storedReasoningEffort, updateAssistantSettings, variant])

  const onThinkingChange = useCallback(
    (option: ThinkingOption) => {
      if (isControlled) {
        onReasoningEffortChange?.(option)
        return
      }

      updateAssistantSettings({
        reasoning_effort: option,
        reasoning_effort_cache: option,
        qwenThinkMode: option !== 'none'
      })
    },
    [isControlled, onReasoningEffortChange, updateAssistantSettings]
  )

  const reasoningEffortOptionLabelMap = useMemo(
    () =>
      ({
        default: t('assistants.settings.reasoning_effort.default'),
        none: t('assistants.settings.reasoning_effort.off'),
        minimal: t('assistants.settings.reasoning_effort.minimal'),
        high: t('assistants.settings.reasoning_effort.high'),
        low: t('assistants.settings.reasoning_effort.low'),
        medium: t('assistants.settings.reasoning_effort.medium'),
        auto: t('assistants.settings.reasoning_effort.auto'),
        xhigh: t('assistants.settings.reasoning_effort.xhigh')
      }) as const satisfies Record<ThinkingOption, string>,
    [t]
  )

  const reasoningEffortDescriptionMap = useMemo(
    () =>
      ({
        default: t('assistants.settings.reasoning_effort.default_description'),
        none: t('assistants.settings.reasoning_effort.off_description'),
        minimal: t('assistants.settings.reasoning_effort.minimal_description'),
        low: t('assistants.settings.reasoning_effort.low_description'),
        medium: t('assistants.settings.reasoning_effort.medium_description'),
        high: t('assistants.settings.reasoning_effort.high_description'),
        xhigh: t('assistants.settings.reasoning_effort.xhigh_description'),
        auto: t('assistants.settings.reasoning_effort.auto_description')
      }) as const satisfies Record<ThinkingOption, string>,
    [t]
  )

  const panelItems = useMemo(
    () =>
      supportedOptions.map((option) => ({
        level: option,
        label: reasoningEffortOptionLabelMap[option],
        description: reasoningEffortDescriptionMap[option],
        icon: ThinkingIcon({ option }),
        isSelected: currentReasoningEffort === option,
        action: () => onThinkingChange(option)
      })),
    [
      currentReasoningEffort,
      onThinkingChange,
      reasoningEffortDescriptionMap,
      reasoningEffortOptionLabelMap,
      supportedOptions
    ]
  )

  const isThinkingEnabled = currentReasoningEffort !== 'none'
  const labelKey = variant === 'agent' ? 'agent.input.reasoning_effort' : 'assistants.settings.reasoning_effort.label'
  const controlLabel = t(labelKey)

  const openQuickPanel = useCallback(() => {
    quickPanelHook.open({
      title: controlLabel,
      list: panelItems,
      symbol: QuickPanelReservedSymbol.Thinking
    })
  }, [controlLabel, panelItems, quickPanelHook])

  const handleOpenQuickPanel = useCallback(() => {
    if (quickPanelHook.isVisible && quickPanelHook.symbol === QuickPanelReservedSymbol.Thinking) {
      quickPanelHook.close()
      return
    }
    openQuickPanel()
  }, [openQuickPanel, quickPanelHook])

  useEffect(() => {
    const disposeMenu = quickPanel.registerRootMenu([
      {
        label: controlLabel,
        description: '',
        icon: ThinkingIcon({ option: currentReasoningEffort }),
        isMenu: true,
        action: openQuickPanel
      }
    ])

    const disposeTrigger = quickPanel.registerTrigger(QuickPanelReservedSymbol.Thinking, openQuickPanel)

    return () => {
      disposeMenu()
      disposeTrigger()
    }
  }, [controlLabel, currentReasoningEffort, openQuickPanel, quickPanel])

  const currentOptionLabel = reasoningEffortOptionLabelMap[currentReasoningEffort]
  const ariaLabel = `${controlLabel}: ${currentOptionLabel}`

  if (variant === 'agent') {
    return (
      <AgentEffortButton
        type="button"
        onClick={handleOpenQuickPanel}
        aria-label={ariaLabel}
        aria-pressed={isThinkingEnabled}>
        {ThinkingIcon({ option: currentReasoningEffort })}
        <AgentEffortText>
          {controlLabel}: {currentOptionLabel}
        </AgentEffortText>
        <ChevronDown size={14} />
      </AgentEffortButton>
    )
  }

  return (
    <Tooltip placement="top" title={ariaLabel} mouseLeaveDelay={0} arrow>
      <ActionIconButton
        onClick={handleOpenQuickPanel}
        active={isThinkingEnabled}
        aria-label={ariaLabel}
        aria-pressed={isThinkingEnabled}>
        {ThinkingIcon({ option: currentReasoningEffort })}
      </ActionIconButton>
    </Tooltip>
  )
}

const ThinkingIcon = (props: { option?: ThinkingOption }) => {
  let IconComponent: React.FC<React.SVGProps<SVGSVGElement>>

  switch (props.option) {
    case 'minimal':
      IconComponent = MdiLightbulbOn30
      break
    case 'low':
      IconComponent = MdiLightbulbOn50
      break
    case 'medium':
      IconComponent = MdiLightbulbOn80
      break
    case 'high':
      IconComponent = MdiLightbulbOn90
      break
    case 'xhigh':
      IconComponent = MdiLightbulbOn
      break
    case 'auto':
      IconComponent = MdiLightbulbAutoOutline
      break
    case 'none':
      IconComponent = MdiLightbulbOffOutline
      break
    case 'default':
    default:
      IconComponent = MdiLightbulbQuestion
      break
  }

  return <IconComponent className="icon" width={18} height={18} style={{ marginTop: -2 }} />
}

const AgentEffortButton = styled.button`
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 6px;
  height: 34px;
  padding: 0 11px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-background);
  color: var(--color-text);
  font-size: 12px;
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease,
    box-shadow 0.18s ease;

  .icon {
    flex-shrink: 0;
  }

  &:hover {
    background: var(--color-background-soft);
    border-color: var(--color-primary-soft);
    box-shadow: 0 4px 10px rgba(15, 23, 42, 0.06);
  }
`

const AgentEffortText = styled.span`
  white-space: nowrap;
  font-weight: 500;
`

export default ThinkingButton
