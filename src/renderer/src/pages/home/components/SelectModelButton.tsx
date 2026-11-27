import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { SelectChatModelPopup } from '@renderer/components/Popups/SelectModelPopup'
import { isLocalAi } from '@renderer/config/env'
import { chatModelFilter } from '@renderer/config/models'
import { useAssistant, useDefaultModel } from '@renderer/hooks/useAssistant'
import { useProvider } from '@renderer/hooks/useProvider'
import { modelRecoveryIntents } from '@renderer/services/modelRecoveryIntents'
import { getProviderName } from '@renderer/services/ProviderService'
import type { Assistant, Topic } from '@renderer/types'
import { Button, Tag } from 'antd'
import { ChevronsUpDown } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  assistant: Assistant
  topic?: Topic
  onTopicChange?: (topic: Topic) => void
  persistAsDefault?: boolean
}

const SelectModelButton: FC<Props> = ({ assistant, topic, onTopicChange, persistAsDefault = false }) => {
  const { model: storedModel, updateAssistant, updateTopic } = useAssistant(assistant.id)
  const { setDefaultModel } = useDefaultModel()
  const model = topic?.model ?? assistant.model ?? storedModel
  const { t } = useTranslation()
  const timerRef = useRef<NodeJS.Timeout>(undefined)
  const provider = useProvider(model?.provider)

  const onSelectModel = async (event: React.MouseEvent<HTMLElement>) => {
    event.currentTarget.blur()
    const selectedModel = await SelectChatModelPopup.show({ model, filter: chatModelFilter })
    if (selectedModel) {
      // 避免更新数据造成关闭弹框的卡顿
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        if (persistAsDefault) {
          setDefaultModel(selectedModel)
        }
        if (topic) {
          modelRecoveryIntents.set(`topic:${topic.id}`, undefined)
          const nextTopic = { ...topic, model: selectedModel }
          updateTopic(nextTopic)
          onTopicChange?.(nextTopic)
        } else {
          updateAssistant({ model: selectedModel })
        }
      }, 200)
    }
  }

  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current)
    }
  }, [])

  if (isLocalAi) {
    return null
  }

  const providerName = getProviderName(model)

  return (
    <DropdownButton size="small" type="text" onClick={onSelectModel}>
      <ButtonContent>
        <ModelAvatar model={model} size={16} />
        <ModelName title={model ? `${model.name}${providerName ? ` | ${providerName}` : ''}` : undefined}>
          {model ? model.name : t('button.select_model')}
          {providerName && <ProviderSuffix> · {providerName}</ProviderSuffix>}
        </ModelName>
      </ButtonContent>
      <ChevronsUpDown size={13} color="var(--zen-text-3)" />
      {model && !provider && <Tag color="error">{t('models.invalid_model')}</Tag>}
    </DropdownButton>
  )
}

const DropdownButton = styled(Button)`
  && {
    height: 35px;
    font-size: 12.5px;
    border-radius: var(--zen-radius-pill);
    padding: 0 14px 0 11px;
    -webkit-app-region: no-drag;
    background: var(--zen-glass-pill);
    backdrop-filter: blur(28px) saturate(165%);
    -webkit-backdrop-filter: blur(28px) saturate(165%);
    border: 0;
    box-shadow: var(--zen-shadow-pill);
    transition:
      background 160ms ease,
      box-shadow 180ms ease,
      transform 150ms cubic-bezier(0.22, 1, 0.36, 1);

    &:hover {
      background: var(--zen-glass-pill-hover) !important;
      box-shadow: var(--zen-shadow-pill-hover) !important;
      transform: translateY(-0.5px);
    }

    &:active {
      transform: scale(0.985);
    }
  }
`

const ButtonContent = styled.div`
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
`

const ModelName = styled.span`
  font-weight: 500;
  font-size: 12.5px;
  color: var(--zen-text-1);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const ProviderSuffix = styled.span`
  color: var(--zen-text-3);
  font-weight: 400;
`

export default SelectModelButton
