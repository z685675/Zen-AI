import { LoadingIcon } from '@renderer/components/Icons'
import { selectNewTopicLoading } from '@renderer/hooks/useMessageOperations'
import { useAppSelector } from '@renderer/store'
import { MessageBlockType } from '@renderer/types/newMessage'
import { getToolDisplayInfo, getToolStatusLabel } from '@renderer/pages/home/Messages/Tools/toolDisplay'
import { CheckCircle, TriangleAlert } from 'lucide-react'
import { type FC, useEffect, useMemo, useState } from 'react'
import styled from 'styled-components'

type Props = {
  topicId: string
}

type AgentTaskStatus = {
  label: string
  tone: 'running' | 'success' | 'error'
}

const COMPLETED_VISIBLE_MS = 3600

const AgentTaskStatusBar: FC<Props> = ({ topicId }) => {
  const loading = useAppSelector((state) => selectNewTopicLoading(state, topicId))
  const messageIds = useAppSelector((state) => state.messages.messageIdsByTopic[topicId] ?? [])
  const messageEntities = useAppSelector((state) => state.messages.entities)
  const blockEntities = useAppSelector((state) => state.messageBlocks.entities)
  const [recentlyCompleted, setRecentlyCompleted] = useState(false)

  useEffect(() => {
    if (loading) {
      setRecentlyCompleted(false)
      return
    }

    if (!messageIds.length) {
      return
    }

    setRecentlyCompleted(true)
    const timer = window.setTimeout(() => setRecentlyCompleted(false), COMPLETED_VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [loading, messageIds.length])

  const status = useMemo<AgentTaskStatus | undefined>(() => {
    for (const messageId of messageIds.toReversed()) {
      const message = messageEntities[messageId]
      if (!message?.blocks?.length) continue

      for (const blockId of message.blocks.toReversed()) {
        const block = blockEntities[blockId]
        if (block?.type !== MessageBlockType.TOOL) continue

        const toolResponse = block.metadata?.rawMcpToolResponse
        const tool = toolResponse?.tool
        const toolName = tool?.name ?? block.toolName
        const displayInfo = getToolDisplayInfo(toolName, tool?.type === 'mcp' ? tool : undefined)
        const hasError = toolResponse?.response?.isError === true || toolResponse?.status === 'error'
        const statusLabel = getToolStatusLabel(toolResponse?.status, displayInfo, hasError)

        if (hasError) {
          return { label: statusLabel ?? '任务处理失败', tone: 'error' }
        }

        if (loading) {
          if (toolResponse?.status === 'done') {
            return { label: '正在整理结果', tone: 'running' }
          }

          return { label: statusLabel ?? displayInfo.activeLabel ?? '正在处理任务', tone: 'running' }
        }

        return { label: statusLabel ?? displayInfo.doneLabel ?? '任务已完成', tone: 'success' }
      }
    }

    if (loading) {
      return { label: '正在处理任务', tone: 'running' }
    }

    if (recentlyCompleted) {
      return { label: '任务已完成', tone: 'success' }
    }

    return undefined
  }, [blockEntities, loading, messageEntities, messageIds, recentlyCompleted])

  if (!status || (!loading && !recentlyCompleted && status.tone !== 'error')) {
    return null
  }

  return (
    <StatusContainer $tone={status.tone}>
      <StatusIcon>
        {status.tone === 'running' ? (
          <LoadingIcon />
        ) : status.tone === 'success' ? (
          <CheckCircle size={14} />
        ) : (
          <TriangleAlert size={14} />
        )}
      </StatusIcon>
      <StatusText>{status.label}</StatusText>
    </StatusContainer>
  )
}

const getToneColor = (tone: AgentTaskStatus['tone']) => {
  switch (tone) {
    case 'success':
      return 'var(--color-status-success, #22c55e)'
    case 'error':
      return 'var(--color-status-error, #ff4d4f)'
    case 'running':
    default:
      return 'var(--color-primary)'
  }
}

const getToneBackground = (tone: AgentTaskStatus['tone']) => {
  switch (tone) {
    case 'success':
      return 'rgba(34, 197, 94, 0.08)'
    case 'error':
      return 'rgba(255, 77, 79, 0.08)'
    case 'running':
    default:
      return 'rgba(22, 119, 255, 0.08)'
  }
}

const StatusContainer = styled.div<{ $tone: AgentTaskStatus['tone'] }>`
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  width: fit-content;
  margin-bottom: 8px;
  padding: 7px 11px;
  border-radius: 999px;
  color: ${(props) => getToneColor(props.$tone)};
  background: ${(props) => getToneBackground(props.$tone)};
  border: 0.5px solid color-mix(in srgb, ${(props) => getToneColor(props.$tone)} 24%, transparent);
  box-shadow: 0 8px 22px rgba(15, 23, 42, 0.04);
`

const StatusIcon = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
`

const StatusText = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 500;
`

export default AgentTaskStatusBar
