import { LoadingIcon } from '@renderer/components/Icons'
import { selectNewTopicLoading } from '@renderer/hooks/useMessageOperations'
import { getContextTelemetry } from '@renderer/services/context/ContextTelemetryService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { pauseTrace } from '@renderer/services/SpanManagerService'
import { useAppSelector } from '@renderer/store'
import type { ContextTelemetry } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { abortCompletion } from '@renderer/utils/abortController'
import { Square } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import {
  hasVisibleAssistantActivity,
  isTaskProgressVisible,
  nativeTaskStage,
  taskElapsedSeconds,
  taskProgressLabel
} from './taskProgressStatus'

export default function AgentTaskProgress({
  message,
  hasRenderedContent
}: {
  message: Message
  hasRenderedContent: boolean
}) {
  const { t } = useTranslation()
  const loading = useAppSelector((state) => selectNewTopicLoading(state, message.topicId))
  const entities = useAppSelector((state) => state.messageBlocks.entities)
  const currentTurn = useAppSelector((state) => {
    const ids = state.messages.messageIdsByTopic[message.topicId] ?? []
    const lastUser = ids.findLast((id) => state.messages.entities[id]?.role === 'user')
    return lastUser === message.askId
  })
  const [telemetry, setTelemetry] = useState<ContextTelemetry | undefined>()
  const [now, setNow] = useState(Date.now)
  const [stopping, setStopping] = useState(false)
  const blocks = useMemo(() => message.blocks.map((id) => entities[id]), [message.blocks, entities])
  const visible = currentTurn && isTaskProgressVisible(message, loading, hasRenderedContent)
  const hasBufferedOutput = hasVisibleAssistantActivity(blocks)

  useEffect(() => {
    if (!visible) return
    setTelemetry(getContextTelemetry(message.topicId))
    setStopping(false)
    return EventEmitter.on(EVENT_NAMES.CONTEXT_STATUS_UPDATED, (value: ContextTelemetry) => {
      if (value.conversationId === message.topicId) setTelemetry(value)
    })
  }, [message.id, message.topicId, visible])
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [visible, message.id])

  if (!visible) return null
  const elapsed = taskElapsedSeconds(message, now)
  const stage = nativeTaskStage(message, telemetry)
  const delayed = elapsed >= 30 && stage !== 'waiting_permission' && !hasBufferedOutput
  return (
    <Progress role="status" aria-live="polite">
      <Row>
        <LoadingIcon />
        <Label>
          {stopping
            ? t('new_assistant.stopping')
            : hasBufferedOutput
              ? t('new_assistant.outputting')
              : taskProgressLabel(message, telemetry, t)}
        </Label>
        <Elapsed aria-live="off">{t('new_assistant.elapsed', { seconds: elapsed })}</Elapsed>
        {message.askId && (
          <StopButton
            type="button"
            disabled={stopping}
            onClick={() => {
              setStopping(true)
              window.keyv?.set(`agent-session-interrupted-${message.askId}`, Date.now())
              abortCompletion(message.askId!)
              void pauseTrace(message.topicId)
            }}>
            <Square size={11} />
            {t('new_assistant.stop')}
          </StopButton>
        )}
      </Row>
      {delayed && !stopping && <Hint>{t('new_assistant.wait_hint')}</Hint>}
    </Progress>
  )
}

const Progress = styled.div`
  margin: 10px 0 8px 46px;
  padding: 9px 12px;
  border-left: 2px solid color-mix(in srgb, var(--color-primary) 35%, transparent);
  color: var(--color-text-2);
  font-size: 12px;
`
const Row = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
`
const Label = styled.span`
  min-width: 0;
  overflow-wrap: anywhere;
`
const Elapsed = styled.span`
  color: var(--color-text-3);
  font-variant-numeric: tabular-nums;
`
const StopButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px;
  border: none;
  border-radius: 5px;
  background: var(--color-background-soft);
  color: var(--color-text-2);
  cursor: pointer;
  &:disabled { opacity: 0.6; cursor: default; }
  &:hover:not(:disabled) { background: var(--color-background-mute); }
`
const Hint = styled.div`
  margin-top: 6px;
  color: var(--color-text-3);
  line-height: 1.6;
`
