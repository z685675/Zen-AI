import { showErrorDetailPopup } from '@renderer/components/ErrorDetailModal'
import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import { useTimer } from '@renderer/hooks/useTimer'
import type { DiagnosisResult } from '@renderer/services/ErrorDiagnosisService'
import { exportErrorDiagnosticPackage } from '@renderer/services/ErrorDiagnosticPackageService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { removeBlocksThunk, resendMessageThunk } from '@renderer/store/thunk/messageThunk'
import type { Assistant } from '@renderer/types'
import type { ErrorMessageBlock, Message } from '@renderer/types/newMessage'
import { extractAgentSessionIdFromTopicId } from '@renderer/utils/agentSession'
import { diagnoseClientError } from '@renderer/utils/clientErrorDiagnosis'
import { classifyError } from '@renderer/utils/errorClassifier'
import { Button } from 'antd'
import { AlertTriangle, ChevronRight, Download, RefreshCw, Wrench, X } from 'lucide-react'
import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'

interface Props {
  block: ErrorMessageBlock
  message: Message
}

const getErrorText = (error: unknown): string => {
  if (!error) return ''
  if (typeof error === 'string') return error

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

const isDependencyError = (error: unknown): boolean => {
  const text = getErrorText(error).toLowerCase()

  return (
    text.includes('modulenotfounderror') ||
    text.includes('no module named') ||
    text.includes('cannot find module') ||
    text.includes('command not found') ||
    text.includes('is not recognized as an internal or external command') ||
    text.includes('enoent') ||
    text.includes('git bash') ||
    text.includes('git not found') ||
    text.includes('bun not found') ||
    text.includes('uv not found') ||
    text.includes('uvx not found')
  )
}

const AgentErrorFallbackCard: React.FC<Props> = ({ block, message }) => {
  const dispatch = useAppDispatch()
  const client = useAgentClient()
  const { setTimeoutTimer } = useTimer()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [exporting, setExporting] = useState(false)

  const relatedUserMessage = useAppSelector((state) =>
    message.askId ? state.messages.entities[message.askId] : undefined
  )
  const blockEntities = useAppSelector((state) => state.messageBlocks.entities)

  const providerId = message.model?.provider ?? (block.error?.providerId as string | undefined)
  const classification = useMemo(() => classifyError(block.error, providerId), [block.error, providerId])
  const dependencyIssue = useMemo(() => isDependencyError(block.error), [block.error])
  const clientDiagnosis = useMemo(
    () =>
      diagnoseClientError(block.error, {
        model: message.model,
        blockId: block.id,
        messageId: message.id,
        createdAt: block.createdAt || message.createdAt
      }),
    [block.error, block.id, block.createdAt, message.model, message.id, message.createdAt]
  )

  const diagnosisContext = useMemo(
    () => ({
      errorSource: 'chat' as const,
      providerName: block.error?.providerId as string | undefined,
      modelId: block.error?.modelId as string | undefined
    }),
    [block.error?.providerId, block.error?.modelId]
  )

  const assistantForRetry = useMemo<Assistant>(
    () => ({
      id: message.assistantId,
      name: t('agent.errorFallback.assistant_name'),
      prompt: '',
      topics: [],
      type: 'agent-session',
      model: message.model,
      defaultModel: message.model,
      settings: {},
      tags: [],
      enableWebSearch: false
    }),
    [message.assistantId, message.model, t]
  )

  const title = dependencyIssue
    ? t('agent.errorFallback.dependency_title')
    : classification.category === 'auth' || classification.category === 'model' || classification.category === 'quota'
      ? t('agent.errorFallback.model_title')
      : classification.category === 'network' ||
          classification.category === 'proxy' ||
          classification.category === 'server' ||
          classification.category === 'stream'
        ? t('agent.errorFallback.connection_title')
        : t('agent.errorFallback.title')

  const description = dependencyIssue
    ? t('agent.errorFallback.dependency_description')
    : clientDiagnosis.summary || t('agent.errorFallback.description')

  const showErrorDetail = useCallback(() => {
    showErrorDetailPopup({
      error: block.error,
      blockId: block.id,
      messageId: message.id,
      model: message.model,
      createdAt: block.createdAt || message.createdAt,
      cachedDiagnosis: block.metadata?.diagnosis as DiagnosisResult | undefined,
      diagnosisContext
    })
  }, [block, diagnosisContext, message])

  const onRemoveBlock = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setTimeoutTimer('onRemoveBlock', () => dispatch(removeBlocksThunk(message.topicId, message.id, [block.id])), 350)
    },
    [block.id, dispatch, message.id, message.topicId, setTimeoutTimer]
  )

  const retryTask = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!relatedUserMessage || relatedUserMessage.role !== 'user') {
        window.toast.error(t('agent.errorFallback.retry_missing_user'))
        return
      }

      await dispatch(resendMessageThunk(message.topicId, relatedUserMessage, assistantForRetry))
    },
    [assistantForRetry, dispatch, message.topicId, relatedUserMessage, t]
  )

  const openEnvironmentSettings = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    window.navigate('/settings/assistant-environment')
  }, [])

  const openRelatedSettings = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (classification.navTarget) {
        navigate(classification.navTarget)
      }
    },
    [classification.navTarget, navigate]
  )

  const exportDiagnosticPackage = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      setExporting(true)

      try {
        const appInfo = await window.api.getAppInfo().catch(() => undefined)
        const privacyNotice = t('agent.errorFallback.privacy_notice')
        const sessionId = extractAgentSessionIdFromTopicId(message.topicId)
        const sessionContext = await Promise.race([
          client.getSession(message.assistantId, sessionId).catch(() => undefined),
          new Promise<undefined>((resolve) => {
            window.setTimeout(() => resolve(undefined), 1500)
          })
        ])
        const savedPath = await exportErrorDiagnosticPackage({
          source: 'agent',
          title,
          description,
          classification,
          dependencyIssue,
          diagnosis: clientDiagnosis,
          error: block.error,
          block,
          message,
          relatedUserMessage,
          blockEntities,
          model: message.model,
          appInfo,
          sessionContext,
          aiDiagnosis: block.metadata?.diagnosis,
          privacyNotice
        })

        window.toast.success(t('agent.errorFallback.export_success', { path: savedPath }))
      } catch (error: any) {
        if (
          !String(error?.message ?? error)
            .toLowerCase()
            .includes('canceled')
        ) {
          window.toast.error(t('agent.errorFallback.export_failed'))
        }
      } finally {
        setExporting(false)
      }
    },
    [
      block,
      blockEntities,
      client,
      classification,
      clientDiagnosis,
      dependencyIssue,
      description,
      message,
      relatedUserMessage,
      t,
      title
    ]
  )

  return (
    <Card className="group" onClick={showErrorDetail}>
      <CloseButton type="button" onClick={onRemoveBlock} aria-label="close" title={t('common.close')}>
        <X size={14} />
      </CloseButton>

      <Header>
        <IconWrap>
          <AlertTriangle size={18} />
        </IconWrap>
        <TitleGroup>
          <Title>{title}</Title>
          <Subtitle>{t('agent.errorFallback.subtitle')}</Subtitle>
        </TitleGroup>
      </Header>

      <Description>{description}</Description>

      <Actions>
        {dependencyIssue && (
          <Button size="small" type="primary" icon={<Wrench size={14} />} onClick={openEnvironmentSettings}>
            {t('agent.errorFallback.fix_environment')}
          </Button>
        )}
        {classification.navTarget && !dependencyIssue && (
          <Button size="small" onClick={openRelatedSettings}>
            {t('error.diagnosis.go_to_settings')}
          </Button>
        )}
        <Button size="small" icon={<RefreshCw size={14} />} onClick={retryTask} disabled={!relatedUserMessage}>
          {t('agent.errorFallback.retry')}
        </Button>
        <Button size="small" icon={<Download size={14} />} onClick={exportDiagnosticPackage} loading={exporting}>
          {t('agent.errorFallback.export_package')}
        </Button>
        <DetailHint>
          {t('agent.errorFallback.detail')}
          <ChevronRight size={14} />
        </DetailHint>
      </Actions>
    </Card>
  )
}

const Card = styled.div`
  position: relative;
  margin: 8px 0;
  padding: 14px 14px 12px;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--color-error) 18%, transparent);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--color-error) 5%, transparent), transparent 62%),
    var(--color-background);
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
  cursor: pointer;

  &:hover {
    border-color: color-mix(in srgb, var(--color-error) 30%, transparent);
    background:
      linear-gradient(135deg, color-mix(in srgb, var(--color-error) 7%, transparent), transparent 62%),
      var(--color-background);
  }
`

const CloseButton = styled.button`
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  height: 22px;
  width: 22px;
  cursor: pointer;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-3);
  opacity: 0;
  transition:
    opacity 0.15s ease,
    background 0.15s ease,
    color 0.15s ease;

  ${Card}:hover & {
    opacity: 1;
  }

  &:hover {
    color: var(--color-error);
    background: color-mix(in srgb, var(--color-error) 12%, transparent);
  }
`

const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding-right: 24px;
`

const IconWrap = styled.div`
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 12px;
  color: var(--color-error);
  background: color-mix(in srgb, var(--color-error) 10%, transparent);
`

const TitleGroup = styled.div`
  min-width: 0;
`

const Title = styled.div`
  color: var(--color-text);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
`

const Subtitle = styled.div`
  margin-top: 2px;
  color: var(--color-text-3);
  font-size: 12px;
`

const Description = styled.div`
  margin: 10px 0 0 44px;
  color: var(--color-text-2);
  font-size: 12px;
  line-height: 1.65;
  word-break: break-word;
`

const Actions = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0 0 44px;
`

const DetailHint = styled.div`
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--color-text-3);
  font-size: 12px;
`

export default React.memo(AgentErrorFallbackCard)
