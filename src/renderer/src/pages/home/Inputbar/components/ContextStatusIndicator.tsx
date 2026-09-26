import type { ContextCheckpoint } from '@renderer/services/context/ContextCompactionService'
import {
  loadContextCheckpoint,
  loadContextUserMemory,
  MAX_CONTEXT_USER_MEMORY_CHARS,
  saveContextUserMemory
} from '@renderer/services/context/ContextCompactionService'
import { getContextTelemetry } from '@renderer/services/context/ContextTelemetryService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { ContextTelemetry } from '@renderer/types'
import { Input, Modal, Popover } from 'antd'
import { AlertCircle, Brain, Check, Database, LoaderCircle, RotateCw } from 'lucide-react'
import { type FC, useEffect, useMemo, useRef, useState } from 'react'
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
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [checkpoint, setCheckpoint] = useState<ContextCheckpoint | undefined>()
  const [memoryDraft, setMemoryDraft] = useState('')
  const [savingMemory, setSavingMemory] = useState(false)
  const memoryDraftRef = useRef('')
  const savedMemoryContentRef = useRef('')

  const updateMemoryDraft = (content: string) => {
    memoryDraftRef.current = content
    setMemoryDraft(content)
  }

  const loadMemoryState = () => {
    setCheckpoint(loadContextCheckpoint(conversationId))
    const content = loadContextUserMemory(conversationId)?.content ?? ''
    savedMemoryContentRef.current = content
    updateMemoryDraft(content)
  }

  useEffect(() => {
    setTelemetry(getContextTelemetry(conversationId))
    setShowRecentCompletion(false)
    const unsubscribe = EventEmitter.on(EVENT_NAMES.CONTEXT_STATUS_UPDATED, (next: ContextTelemetry) => {
      if (next.conversationId !== conversationId) return
      setTelemetry(next)
      if (next.status === 'complete') {
        setShowRecentCompletion(true)
        setCheckpoint(loadContextCheckpoint(conversationId))
        // Refresh auto-absorbed notes, but never overwrite edits currently in progress.
        if (memoryDraftRef.current === savedMemoryContentRef.current) {
          const content = loadContextUserMemory(conversationId)?.content ?? ''
          savedMemoryContentRef.current = content
          updateMemoryDraft(content)
        }
      }
    })
    return () => unsubscribe()
  }, [conversationId])

  useEffect(() => {
    loadMemoryState()
    // The local memory store is intentionally scoped to the conversation ID.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const localCheckpointNotice = t('chat.input.context_manager.local_checkpoint_fallback', {
    defaultValue: '远程整理模型暂不可用，已使用本地 checkpoint 继续处理'
  })

  const statusText = telemetry
    ? isActive
      ? telemetry.detail || t('chat.input.context_manager.processing')
      : isError
        ? t('chat.input.context_manager.error')
        : showRecentCompletion
          ? telemetry.localCheckpointUsed
            ? `${localCheckpointNotice}，回答已完成`
            : t('chat.input.context_manager.ready')
          : telemetry.resourceCount > 0
            ? t('chat.input.context_manager.managed_resources', { count: telemetry.resourceCount })
            : t('chat.input.context_manager.managed')
    : ''

  const content = telemetry && (
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
      <StatsNote>
        {telemetry.localCheckpointUsed ? localCheckpointNotice : t('chat.input.context_manager.note')}
      </StatsNote>
    </Stats>
  )

  const handleSaveMemory = () => {
    setSavingMemory(true)
    try {
      const saved = saveContextUserMemory(conversationId, memoryDraft)
      if (memoryDraft.length > MAX_CONTEXT_USER_MEMORY_CHARS) return
      const content = saved?.content ?? ''
      savedMemoryContentRef.current = content
      updateMemoryDraft(content)
      window.toast?.success(
        t('chat.input.context_memory.saved', {
          defaultValue: '已保存；从下一次发出的请求开始生效。'
        })
      )
      setMemoryOpen(false)
    } catch {
      window.toast?.error(
        t('chat.input.context_memory.save_error', {
          defaultValue: '保存失败，请重试。'
        })
      )
    } finally {
      setSavingMemory(false)
    }
  }

  const checkpointUpdatedAt = checkpoint?.updatedAt ? new Date(checkpoint.updatedAt).toLocaleString() : undefined

  return (
    <IndicatorSlot>
      <IndicatorActions>
        <MemoryButton
          type="button"
          onClick={() => {
            loadMemoryState()
            setMemoryOpen(true)
          }}>
          <Brain size={13} />
          <span>{t('chat.input.context_memory.short_title', { defaultValue: '会话记忆' })}</span>
        </MemoryButton>
        {visible && telemetry && (
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
        )}
      </IndicatorActions>

      <Modal
        open={memoryOpen}
        title={t('chat.input.context_memory.title', { defaultValue: '查看与编辑会话记忆' })}
        onCancel={() => setMemoryOpen(false)}
        onOk={handleSaveMemory}
        okText={t('common.save', { defaultValue: '保存' })}
        cancelText={t('common.cancel', { defaultValue: '取消' })}
        confirmLoading={savingMemory}
        okButtonProps={{ disabled: memoryDraft.length > MAX_CONTEXT_USER_MEMORY_CHARS }}
        width={720}>
        <DialogIntro>
          {t('chat.input.context_memory.intro', {
            defaultValue:
              '这里展示本会话的自动整理摘要。你可以单独补充或修正重要信息；手动内容会一直保留，并在事实冲突时优先于自动摘要。'
          })}
        </DialogIntro>

        <SectionLabel>
          {t('chat.input.context_memory.auto_summary', { defaultValue: 'AI 自动整理的记忆' })}
        </SectionLabel>
        {checkpoint ? (
          <>
            <SummaryMeta>
              {checkpointUpdatedAt &&
                t('chat.input.context_memory.updated_at', {
                  defaultValue: '最近整理：{{time}}',
                  time: checkpointUpdatedAt
                })}
              {checkpointUpdatedAt && checkpoint.sourceTokens > 0 && ' · '}
              {checkpoint.sourceTokens > 0 &&
                t('chat.input.context_memory.source_tokens', {
                  tokens: checkpoint.sourceTokens.toLocaleString()
                })}
            </SummaryMeta>
            <SummaryPreview>{checkpoint.summary}</SummaryPreview>
          </>
        ) : (
          <EmptySummary>
            {t('chat.input.context_memory.not_ready', {
              defaultValue:
                '这段对话还没有触发自动整理。对话变长后，系统会按需生成摘要；你现在保存的手动记忆仍会正常使用。'
            })}
          </EmptySummary>
        )}

        <SectionLabel $spaced>
          {t('chat.input.context_memory.user_memory', { defaultValue: '我的补充与修正' })}
        </SectionLabel>
        <Input.TextArea
          value={memoryDraft}
          onChange={(event) => updateMemoryDraft(event.target.value)}
          maxLength={MAX_CONTEXT_USER_MEMORY_CHARS}
          showCount
          autoSize={{ minRows: 5, maxRows: 11 }}
          placeholder={t('chat.input.context_memory.placeholder', {
            defaultValue: '例如：前面提到的预算已经调整为 2 万元；项目代号是 ZEN-42；后续请优先采用方案 B。'
          })}
        />
        <DialogNote>
          {t('chat.input.context_memory.note', {
            defaultValue:
              '保存后从下一次发出的请求开始生效，不会修改原始聊天记录，也不会中断正在生成的回答。留空并保存可删除手动记忆。'
          })}
        </DialogNote>
      </Modal>
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

const IndicatorActions = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
`

const MemoryButton = styled.button`
  display: flex;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--color-background);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
  color: var(--color-text-2);
  font-size: 11px;
  line-height: 1;
  align-items: center;
  gap: 5px;
  pointer-events: auto;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    color: var(--color-primary);
    border-color: var(--color-primary);
  }
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

const DialogIntro = styled.p`
  margin: 0 0 16px;
  color: var(--color-text-2);
  font-size: 13px;
  line-height: 1.65;
`

const SectionLabel = styled.div<{ $spaced?: boolean }>`
  margin: ${({ $spaced }) => ($spaced ? '18px 0 8px' : '0 0 6px')};
  color: var(--color-text);
  font-size: 13px;
  font-weight: 600;
`

const SummaryMeta = styled.div`
  margin-bottom: 8px;
  color: var(--color-text-3);
  font-size: 11px;
`

const SummaryPreview = styled.pre`
  max-height: 260px;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-soft);
  color: var(--color-text-2);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow: auto;
  overflow-wrap: anywhere;
`

const EmptySummary = styled.div`
  padding: 12px;
  border: 1px dashed var(--color-border);
  border-radius: 8px;
  color: var(--color-text-3);
  font-size: 12px;
  line-height: 1.6;
`

const DialogNote = styled.div`
  margin-top: 8px;
  color: var(--color-text-3);
  font-size: 11px;
  line-height: 1.55;
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
