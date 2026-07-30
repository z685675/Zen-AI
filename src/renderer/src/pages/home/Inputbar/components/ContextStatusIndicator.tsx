import { getContextTelemetry } from '@renderer/services/context/ContextTelemetryService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { ContextTelemetry } from '@renderer/types'
import { Popover } from 'antd'
import { AlertCircle, Check, Database, LoaderCircle, RotateCw } from 'lucide-react'
import { type FC, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled, { keyframes } from 'styled-components'

interface Props {
  conversationId: string
}

const ACTIVE_STATUSES = new Set(['analyzing', 'extracting', 'compacting', 'retrieving', 'retrying'])

const ContextStatusIndicator: FC<Props> = ({ conversationId }) => {
  const { t } = useTranslation()
  const [telemetry, setTelemetry] = useState<ContextTelemetry | undefined>(() => getContextTelemetry(conversationId))
  const [showRecentCompletion, setShowRecentCompletion] = useState(false)

  useEffect(() => {
    setTelemetry(getContextTelemetry(conversationId))
    setShowRecentCompletion(false)
    const unsubscribe = EventEmitter.on(EVENT_NAMES.CONTEXT_STATUS_UPDATED, (next: ContextTelemetry) => {
      if (next.conversationId !== conversationId) return
      setTelemetry(next)
      if (next.status === 'complete') {
        setShowRecentCompletion(true)
      }
    })
    return () => unsubscribe()
  }, [conversationId])

  useEffect(() => {
    if (!showRecentCompletion) return
    const timer = window.setTimeout(() => setShowRecentCompletion(false), 3_000)
    return () => window.clearTimeout(timer)
  }, [showRecentCompletion])

  const hasManagedData = Boolean(
    telemetry &&
      (telemetry.resourceCount ||
        telemetry.compressionCount ||
        telemetry.retrievedChunks ||
        telemetry.retryCount ||
        telemetry.cacheHits ||
        telemetry.cacheMisses)
  )
  const isActive = Boolean(telemetry && ACTIVE_STATUSES.has(telemetry.status))
  const isError = telemetry?.status === 'error'
  const visible = isActive || isError || showRecentCompletion || hasManagedData

  const progressText = useMemo(() => {
    if (!telemetry?.totalItems) return ''
    return `${Math.min(telemetry.processedItems, telemetry.totalItems)}/${telemetry.totalItems}`
  }, [telemetry])

  if (!visible || !telemetry) return null

  const statusText = isActive
    ? telemetry.detail || t('chat.input.context_manager.processing')
    : isError
      ? t('chat.input.context_manager.error')
      : showRecentCompletion
        ? t('chat.input.context_manager.ready')
        : telemetry.resourceCount > 0
          ? t('chat.input.context_manager.managed_resources', { count: telemetry.resourceCount })
          : t('chat.input.context_manager.managed')

  const content = (
    <Stats>
      <StatsTitle>{t('chat.input.context_manager.title')}</StatsTitle>
      <StatRow>
        <span>{t('chat.input.context_manager.resources')}</span>
        <strong>{telemetry.resourceCount}</strong>
      </StatRow>
      <StatRow>
        <span>{t('chat.input.context_manager.cache')}</span>
        <strong>
          {t('chat.input.context_manager.cache_value', {
            hits: telemetry.cacheHits,
            total: telemetry.cacheHits + telemetry.cacheMisses
          })}
        </strong>
      </StatRow>
      <StatRow>
        <span>{t('chat.input.context_manager.compressions')}</span>
        <strong>{telemetry.compressionCount}</strong>
      </StatRow>
      <StatRow>
        <span>{t('chat.input.context_manager.retrievals')}</span>
        <strong>
          {t('chat.input.context_manager.retrieval_value', {
            count: telemetry.retrievalCount,
            chunks: telemetry.retrievedChunks
          })}
        </strong>
      </StatRow>
      <StatRow>
        <span>{t('chat.input.context_manager.retries')}</span>
        <strong>{telemetry.retryCount}</strong>
      </StatRow>
      {telemetry.lastError && <ErrorText>{telemetry.lastError}</ErrorText>}
      <StatsNote>{t('chat.input.context_manager.note')}</StatsNote>
    </Stats>
  )

  return (
    <IndicatorSlot>
      <Popover content={content} placement="topRight" arrow={false} trigger="click">
        <IndicatorButton $error={isError} type="button">
          {isActive ? (
            telemetry.status === 'retrying' ? (
              <RotateCw size={13} />
            ) : (
              <SpinningLoader size={13} />
            )
          ) : isError ? (
            <AlertCircle size={13} />
          ) : showRecentCompletion ? (
            <Check size={13} />
          ) : (
            <Database size={13} />
          )}
          <span>{statusText}</span>
          {progressText && <ProgressText>{progressText}</ProgressText>}
        </IndicatorButton>
      </Popover>
    </IndicatorSlot>
  )
}

const spin = keyframes`
  to {
    transform: rotate(360deg);
  }
`

const IndicatorSlot = styled.div`
  position: absolute;
  top: -38px;
  right: 8px;
  z-index: 5;
  pointer-events: none;
`

const IndicatorButton = styled.button<{ $error: boolean }>`
  display: flex;
  max-width: min(420px, calc(100vw - 80px));
  height: 28px;
  padding: 0 9px;
  border: 1px solid ${({ $error }) => ($error ? 'var(--color-error)' : 'var(--color-border)')};
  border-radius: 7px;
  background: var(--color-background);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
  color: ${({ $error }) => ($error ? 'var(--color-error)' : 'var(--color-text-2)')};
  font-size: 11px;
  line-height: 1;
  align-items: center;
  gap: 6px;
  pointer-events: auto;
  cursor: pointer;

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`

const SpinningLoader = styled(LoaderCircle)`
  flex: 0 0 auto;
  animation: ${spin} 1s linear infinite;
`

const ProgressText = styled.span`
  flex: 0 0 auto;
  color: var(--color-text-3);
`

const Stats = styled.div`
  width: 230px;
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const StatsTitle = styled.div`
  padding-bottom: 7px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text);
  font-size: 12px;
  font-weight: 600;
`

const StatRow = styled.div`
  display: flex;
  color: var(--color-text-2);
  font-size: 12px;
  justify-content: space-between;
  gap: 18px;

  strong {
    color: var(--color-text);
    font-weight: 500;
  }
`

const ErrorText = styled.div`
  max-height: 72px;
  padding-top: 7px;
  border-top: 1px solid var(--color-border);
  color: var(--color-error);
  font-size: 11px;
  line-height: 1.5;
  overflow: auto;
`

const StatsNote = styled.div`
  padding-top: 7px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-3);
  font-size: 11px;
  line-height: 1.5;
`

export default ContextStatusIndicator
