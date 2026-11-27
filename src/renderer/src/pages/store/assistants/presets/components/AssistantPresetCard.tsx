import { DeleteIcon, EditIcon } from '@renderer/components/Icons'
import CustomTag from '@renderer/components/Tags/CustomTag'
import { useAssistants } from '@renderer/hooks/useAssistant'
import { useAssistantPresets } from '@renderer/hooks/useAssistantPresets'
import AssistantSettingsPopup from '@renderer/pages/settings/AssistantSettings'
import {
  createOrResolveAssistantFromPreset,
  ensureAssistantInQuickDeck,
  removeAssistantFromQuickDeck
} from '@renderer/services/AssistantService'
import { useAppSelector } from '@renderer/store'
import type { AssistantPreset } from '@renderer/types'
import { getLeadingEmoji } from '@renderer/utils'
import { Button, Dropdown } from 'antd'
import { t } from 'i18next'
import { isArray } from 'lodash'
import { Ellipsis, PlusIcon, Settings2, SquareArrowOutUpRight } from 'lucide-react'
import { type FC, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import styled from 'styled-components'

import ManageAssistantPresetsPopup from './ManageAssistantPresetsPopup'

interface Props {
  preset: AssistantPreset
  activegroup?: string
  onClick: () => void
  getLocalizedGroupName: (group: string) => string
}

const AssistantPresetCard: FC<Props> = ({ preset, onClick, activegroup, getLocalizedGroupName }) => {
  const { removeAssistantPreset } = useAssistantPresets()
  const { assistants } = useAssistants()
  const quickAssistantIds = useAppSelector((state) => state.assistants.quickAssistantIds ?? [])
  const [isVisible, setIsVisible] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  const linkedAssistant = useMemo(
    () =>
      assistants.find((assistant) => {
        if (preset.id && assistant.presetId === preset.id) {
          return true
        }

        return assistant.name === preset.name && assistant.prompt === preset.prompt
      }),
    [assistants, preset.id, preset.name, preset.prompt]
  )

  const isInQuickDeck = linkedAssistant ? quickAssistantIds.includes(linkedAssistant.id) : false

  const handleDelete = useCallback(
    (targetPreset: AssistantPreset) => {
      window.modal.confirm({
        centered: true,
        content: t('assistants.presets.delete.popup.content'),
        onOk: () => removeAssistantPreset(targetPreset.id)
      })
    },
    [removeAssistantPreset]
  )

  const exportPreset = useCallback(async () => {
    const result = [
      {
        name: preset.name,
        emoji: preset.emoji,
        group: preset.group,
        prompt: preset.prompt,
        description: preset.description,
        regularPhrases: preset.regularPhrases,
        type: 'agent'
      }
    ]

    const resultStr = JSON.stringify(result, null, 2)

    await window.api.file.save(`${preset.name}.json`, new TextEncoder().encode(resultStr), {
      filters: [{ name: t('assistants.presets.import.file_filter'), extensions: ['json'] }]
    })
  }, [preset])

  const handleAddToQuickDeck = useCallback(async () => {
    const assistant = await createOrResolveAssistantFromPreset(preset)
    ensureAssistantInQuickDeck(assistant.id)
  }, [preset])

  const handleToggleQuickDeck = useCallback(
    async (event?: React.MouseEvent<HTMLElement>) => {
      event?.stopPropagation()
      event?.preventDefault()

      if (linkedAssistant && quickAssistantIds.includes(linkedAssistant.id)) {
        removeAssistantFromQuickDeck(linkedAssistant.id)
        return
      }

      await handleAddToQuickDeck()
    },
    [handleAddToQuickDeck, linkedAssistant, quickAssistantIds]
  )

  const menuItems = [
    {
      key: 'toggle-quick-deck',
      label: isInQuickDeck ? '取消添加' : t('assistants.presets.add.button'),
      icon: <PlusIcon size={14} />,
      onClick: (e: any) => {
        e.domEvent.stopPropagation()
        void handleToggleQuickDeck()
      }
    },
    {
      key: 'edit',
      label: t('assistants.presets.edit.title'),
      icon: <EditIcon size={14} />,
      onClick: (e: any) => {
        e.domEvent.stopPropagation()
        void AssistantSettingsPopup.show({ assistant: preset })
      }
    },
    {
      key: 'manage',
      label: t('assistants.presets.manage.title'),
      icon: <Settings2 size={14} />,
      onClick: (e: any) => {
        e.domEvent.stopPropagation()
        ManageAssistantPresetsPopup.show()
      }
    },
    {
      key: 'export',
      label: t('assistants.presets.export.agent'),
      icon: <SquareArrowOutUpRight size={14} />,
      onClick: (e: any) => {
        e.domEvent.stopPropagation()
        void exportPreset()
      }
    },
    {
      key: 'delete',
      label: t('common.delete'),
      icon: <DeleteIcon size={14} className="lucide-custom" />,
      danger: true,
      onClick: (e: any) => {
        e.domEvent.stopPropagation()
        handleDelete(preset)
      }
    }
  ]

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      { threshold: 0.1 }
    )

    if (cardRef.current) {
      observer.observe(cardRef.current)
    }

    return () => {
      observer.disconnect()
    }
  }, [])

  const emoji = preset.emoji || getLeadingEmoji(preset.name)
  const prompt = (preset.description || preset.prompt).substring(0, 200).replace(/\\n/g, '')

  const content = (
    <AgentCardContainer onClick={onClick} ref={cardRef}>
      {isVisible && (
        <AgentCardBody>
          <AgentCardBackground>{emoji}</AgentCardBackground>
          <AgentCardHeader>
            <AgentCardHeaderInfo>
              <AgentCardHeaderInfoTitle>{preset.name}</AgentCardHeaderInfoTitle>
              <AgentCardHeaderInfoTags>
                {activegroup === '我的' && (
                  <CustomTag color="#A0A0A0" size={11}>
                    {getLocalizedGroupName('我的')}
                  </CustomTag>
                )}
                {isArray(preset.group) &&
                  preset.group.map((group) => (
                    <CustomTag key={group} color="#A0A0A0" size={11}>
                      {getLocalizedGroupName(group)}
                    </CustomTag>
                  ))}
              </AgentCardHeaderInfoTags>
            </AgentCardHeaderInfo>
            <AgentCardHeaderInfoAction>
              <QuickDeckButton
                size="small"
                type={isInQuickDeck ? 'default' : 'primary'}
                onClick={(event) => void handleToggleQuickDeck(event)}>
                {isInQuickDeck ? '取消添加' : '添加'}
              </QuickDeckButton>
              {activegroup === '我的' ? (
                <Dropdown
                  menu={{
                    items: menuItems
                  }}
                  trigger={['click']}
                  placement="bottomRight">
                  <MenuButton
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                    }}
                    color="default"
                    variant="filled"
                    shape="circle"
                    icon={<Ellipsis size={14} color="var(--color-text-3)" />}
                  />
                </Dropdown>
              ) : (
                emoji && <HeaderInfoEmoji>{emoji}</HeaderInfoEmoji>
              )}
            </AgentCardHeaderInfoAction>
          </AgentCardHeader>
          <CardInfo>
            <AgentPrompt>{prompt}</AgentPrompt>
          </CardInfo>
        </AgentCardBody>
      )}
    </AgentCardContainer>
  )

  if (activegroup === '我的') {
    return (
      <Dropdown
        menu={{
          items: menuItems
        }}
        trigger={['contextMenu']}>
        {content}
      </Dropdown>
    )
  }

  return content
}

const AgentCardHeaderInfoAction = styled.div`
  min-width: 96px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  flex-shrink: 0;
`

const QuickDeckButton = styled(Button)`
  min-width: 74px;
  border-radius: 999px;
  font-size: 12px;
  padding-inline: 12px;
`

const HeaderInfoEmoji = styled.div`
  width: 42px;
  height: 42px;
  border-radius: var(--zen-radius-sm);
  font-size: 24px;
  line-height: 1;
  flex-shrink: 0;
  opacity: 1;
  transition: opacity 0.2s ease;
  background: var(--zen-glass-pill);
  box-shadow: var(--zen-shadow-active);
  display: flex;
  align-items: center;
  justify-content: center;
`

const MenuButton = styled(Button)`
  opacity: 0;
  transition: opacity 0.2s ease;
`

const AgentCardContainer = styled.div`
  border-radius: var(--zen-radius-md);
  cursor: pointer;
  border: 0;
  background: var(--zen-glass-card);
  backdrop-filter: blur(22px) saturate(160%);
  -webkit-backdrop-filter: blur(22px) saturate(160%);
  padding: 16px;
  overflow: hidden;
  box-shadow: var(--zen-shadow-card);
  transition:
    box-shadow 180ms ease,
    background 160ms ease,
    transform 150ms ease;

  &:hover {
    background: var(--zen-glass-pill-hover);
    box-shadow: var(--zen-shadow-pill-hover);
    transform: translateY(-1px);

    ${AgentCardHeaderInfoAction} ${HeaderInfoEmoji} {
      opacity: 0;
    }

    ${AgentCardHeaderInfoAction} ${MenuButton} {
      opacity: 1;
    }
  }
`

const AgentCardBody = styled.div`
  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  animation: fadeIn 0.2s ease;
`

const AgentCardBackground = styled.div`
  height: 100%;
  position: absolute;
  top: 0;
  right: -50px;
  font-size: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  opacity: 0.05;
  filter: blur(24px);
  border-radius: 99px;
  overflow: hidden;
`

const AgentCardHeader = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  justify-content: flex-start;
  overflow: hidden;
`

const AgentCardHeaderInfo = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 7px;
`

const AgentCardHeaderInfoTitle = styled.div`
  font-size: 15px;
  line-height: 1.25;
  font-weight: 600;
  color: var(--zen-text-1);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  word-break: break-all;
`

const AgentCardHeaderInfoTags = styled.div`
  display: flex;
  flex-direction: row;
  gap: 5px;
  flex-wrap: wrap;
`

const CardInfo = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  margin-top: 12px;
  background: var(--zen-bg-subtle);
  padding: 9px 11px;
  border-radius: var(--zen-radius-sm);
`

const AgentPrompt = styled.div`
  font-size: 12px;
  display: -webkit-box;
  line-height: 1.55;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--zen-text-2);
`

export default memo(AssistantPresetCard)
