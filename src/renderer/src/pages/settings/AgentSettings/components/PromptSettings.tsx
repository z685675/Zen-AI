import CodeEditor from '@renderer/components/CodeEditor'
import { HSpaceBetweenStack } from '@renderer/components/Layout'
import type { RichEditorRef } from '@renderer/components/RichEditor/types'
import { usePromptProcessor } from '@renderer/hooks/usePromptProcessor'
import { estimateTextTokens } from '@renderer/services/TokenService'
import type { UpdateAgentBaseForm } from '@renderer/types'
import { DEFAULT_FUSION_AGENT_ID } from '@shared/config/agents'
import { Alert, Button, Popover } from 'antd'
import { Edit, HelpCircle, Lock, Save } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import styled from 'styled-components'

import { type AgentOrSessionSettingsProps, SettingsContainer, SettingsItem, SettingsTitle } from '../shared'

const PromptSettings: FC<AgentOrSessionSettingsProps> = ({ agentBase, update }) => {
  const { t } = useTranslation()
  const [instructions, setInstructions] = useState<string>(agentBase?.instructions ?? '')
  const [showPreview, setShowPreview] = useState<boolean>(!!agentBase?.instructions?.length)
  const [tokenCount, setTokenCount] = useState(0)
  const isOfficialAgentPrompt = agentBase?.id === DEFAULT_FUSION_AGENT_ID

  useEffect(() => {
    const updateTokenCount = async () => {
      const count = estimateTextTokens(instructions)
      setTokenCount(count)
    }
    void updateTokenCount()
  }, [instructions])

  const editorRef = useRef<RichEditorRef>(null)

  const processedPrompt = usePromptProcessor({
    prompt: instructions,
    modelName: agentBase?.model
  })

  const updatePrompt = () => {
    if (!agentBase) return
    if (isOfficialAgentPrompt) return
    void update({ id: agentBase.id, instructions } satisfies UpdateAgentBaseForm)
  }

  const promptVarsContent = <pre>{t('assistants.presets.add.prompt.variables.tip.content')}</pre>

  if (!agentBase) return null

  return (
    <SettingsContainer className="flex h-full flex-col overflow-hidden">
      <SettingsItem divider={false} className="flex min-h-0 flex-1 flex-col">
        <SettingsTitle>
          {t('common.prompt')}
          <Popover title={t('assistants.presets.add.prompt.variables.tip.title')} content={promptVarsContent}>
            <HelpCircle size={14} color="var(--color-text-2)" />
          </Popover>
        </SettingsTitle>
        {isOfficialAgentPrompt && (
          <LockedPromptAlert
            type="info"
            showIcon
            message="官方助手的默认提示词不可修改"
            description="为保证智能助手的稳定体验和基础能力一致性，官方助手的底层提示词由应用内置维护。你仍然可以查看内容，并继续调整模型、权限和其他配置。"
          />
        )}
        <TextAreaContainer>
          <RichEditorContainer>
            {showPreview ? (
              <MarkdownContainer
                onDoubleClick={() => {
                  if (isOfficialAgentPrompt) return
                  const currentScrollTop = editorRef.current?.getScrollTop?.() || 0
                  setShowPreview(false)
                  requestAnimationFrame(() => editorRef.current?.setScrollTop?.(currentScrollTop))
                }}>
                <ReactMarkdown>{processedPrompt || instructions}</ReactMarkdown>
              </MarkdownContainer>
            ) : (
              <CodeEditor
                value={instructions}
                language="markdown"
                onChange={isOfficialAgentPrompt ? undefined : setInstructions}
                readOnly={isOfficialAgentPrompt}
                editable={!isOfficialAgentPrompt}
                height="100%"
                expanded={false}
                style={{
                  height: '100%'
                }}
              />
            )}
          </RichEditorContainer>
        </TextAreaContainer>
        <HSpaceBetweenStack width="100%" justifyContent="flex-end" mt="10px">
          <TokenCount>Tokens: {tokenCount}</TokenCount>
          <Button
            type="primary"
            disabled={isOfficialAgentPrompt}
            icon={isOfficialAgentPrompt ? <Lock size={14} /> : showPreview ? <Edit size={14} /> : <Save size={14} />}
            onClick={() => {
              if (isOfficialAgentPrompt) return
              const currentScrollTop = editorRef.current?.getScrollTop?.() || 0
              if (showPreview) {
                setShowPreview(false)
                requestAnimationFrame(() => editorRef.current?.setScrollTop?.(currentScrollTop))
              } else {
                updatePrompt()
                requestAnimationFrame(() => {
                  setShowPreview(true)
                  requestAnimationFrame(() => editorRef.current?.setScrollTop?.(currentScrollTop))
                })
              }
            }}>
            {isOfficialAgentPrompt ? '已锁定' : showPreview ? t('common.edit') : t('common.save')}
          </Button>
        </HSpaceBetweenStack>
      </SettingsItem>
    </SettingsContainer>
  )
}

const TextAreaContainer = styled.div`
  position: relative;
  width: 100%;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  margin-top: 5px;
`

const TokenCount = styled.div`
  padding: 2px 2px;
  border-radius: 4px;
  font-size: 14px;
  color: var(--color-text-2);
  user-select: none;
`

const LockedPromptAlert = styled(Alert)`
  margin: 8px 0;
`

const RichEditorContainer = styled.div`
  height: 100%;
  flex: 1;
  border: 0.5px solid var(--color-border);
  border-radius: 5px;
  overflow: hidden;

  .prompt-rich-editor {
    border: none;
    height: 100%;

    .rich-editor-wrapper {
      height: 100%;
      display: flex;
      flex-direction: column;
    }

    .rich-editor-content {
      flex: 1;
      overflow: auto;
    }
  }
`

const MarkdownContainer = styled.div.attrs({ className: 'markdown' })`
  height: 100%;
  padding: 0.5em;
  overflow: auto;
`

export default PromptSettings
