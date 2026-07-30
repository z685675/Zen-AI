import { LoadingIcon } from '@renderer/components/Icons'
import { selectNewTopicLoading } from '@renderer/hooks/useMessageOperations'
import { getEffectiveStatus, getToolHasError } from '@renderer/pages/home/Messages/Tools/MessageAgentTools/GenericTools'
import { getToolDisplayInfo, getToolStatusLabel } from '@renderer/pages/home/Messages/Tools/toolDisplay'
import { useAppSelector } from '@renderer/store'
import { AssistantMessageStatus, type Message, MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { CheckCircle, TriangleAlert } from 'lucide-react'
import { type FC, useEffect, useMemo, useRef, useState } from 'react'
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
  const wasRunningRef = useRef(false)

  const latestAssistantMessage = useMemo(
    () => getLatestAssistantMessageForCurrentTurn(messageIds, messageEntities),
    [messageEntities, messageIds]
  )
  const latestAssistantBlocks = useMemo(
    () => latestAssistantMessage?.blocks?.map((blockId) => blockEntities[blockId]).filter(Boolean) ?? [],
    [blockEntities, latestAssistantMessage?.blocks]
  )

  const hasInFlightBlocks = latestAssistantBlocks.some(isBlockInFlight)
  const hasTerminalMessageStatus =
    latestAssistantMessage?.status === AssistantMessageStatus.SUCCESS ||
    latestAssistantMessage?.status === AssistantMessageStatus.ERROR
  const isRunning = !hasTerminalMessageStatus && (loading || hasInFlightBlocks)
  const hasTerminalSuccess = latestAssistantMessage?.status === AssistantMessageStatus.SUCCESS && !hasInFlightBlocks
  const hasTerminalError =
    latestAssistantMessage?.status === AssistantMessageStatus.ERROR ||
    (!isRunning &&
      latestAssistantMessage?.status !== AssistantMessageStatus.SUCCESS &&
      latestAssistantBlocks.some(
        (block) => block?.type === MessageBlockType.ERROR || block?.status === MessageBlockStatus.ERROR
      ))

  useEffect(() => {
    wasRunningRef.current = false
    setRecentlyCompleted(false)
  }, [topicId])

  useEffect(() => {
    if (isRunning) {
      wasRunningRef.current = true
      setRecentlyCompleted(false)
      return
    }

    if (!wasRunningRef.current) {
      return
    }
    wasRunningRef.current = false

    if (!messageIds.length) {
      return
    }

    setRecentlyCompleted(true)
    const timer = window.setTimeout(() => setRecentlyCompleted(false), COMPLETED_VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [isRunning, messageIds.length])

  const status = useMemo<AgentTaskStatus | undefined>(() => {
    if (latestAssistantMessage?.blocks?.length) {
      const latestToolBlock = latestAssistantBlocks.toReversed().find((block) => block?.type === MessageBlockType.TOOL)
      const latestToolStatus = getToolTaskStatus(latestToolBlock)
      const hasFinalContent = latestAssistantBlocks.some(hasDeliverableContent)

      if (isRunning) {
        if (latestToolStatus?.tone === 'error') {
          return { label: '遇到问题，正在尝试其他办法', tone: 'running' }
        }

        if (latestToolStatus?.status === 'done') {
          return { label: '正在整理结果', tone: 'running' }
        }

        return latestToolStatus ?? { label: '正在处理任务', tone: 'running' }
      }

      if (hasTerminalError) {
        return { label: latestToolStatus?.tone === 'error' ? latestToolStatus.label : '任务处理失败', tone: 'error' }
      }

      if (
        hasTerminalSuccess ||
        hasFinalContent ||
        (recentlyCompleted && latestAssistantMessage.status !== AssistantMessageStatus.ERROR)
      ) {
        return { label: latestToolStatus?.doneLabel ?? '任务已完成', tone: 'success' }
      }

      if (latestToolStatus?.tone === 'error') {
        return { label: latestToolStatus.label ?? '任务处理失败', tone: 'error' }
      }
    }

    if (isRunning) {
      return { label: '正在处理任务', tone: 'running' }
    }

    if (recentlyCompleted) {
      return { label: '任务已完成', tone: 'success' }
    }

    return undefined
  }, [
    hasTerminalError,
    hasTerminalSuccess,
    isRunning,
    latestAssistantBlocks,
    latestAssistantMessage,
    recentlyCompleted
  ])

  if (!status || (!isRunning && !recentlyCompleted)) {
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

const getLatestAssistantMessageForCurrentTurn = (
  messageIds: string[],
  messageEntities: Record<string, Message | undefined>
): Message | undefined => {
  const latestUserIndex = messageIds.findLastIndex((messageId) => messageEntities[messageId]?.role === 'user')
  const currentTurnMessageIds = latestUserIndex >= 0 ? messageIds.slice(latestUserIndex + 1) : messageIds

  for (const messageId of currentTurnMessageIds.toReversed()) {
    const message = messageEntities[messageId]
    if (message?.role === 'assistant' && message.blocks?.length) {
      return message
    }
  }
  return undefined
}

const isBlockInFlight = (block: any): boolean => {
  if (!block) {
    return false
  }

  if (
    block.status === MessageBlockStatus.PENDING ||
    block.status === MessageBlockStatus.PROCESSING ||
    block.status === MessageBlockStatus.STREAMING
  ) {
    return true
  }

  if (block.type !== MessageBlockType.TOOL) {
    return false
  }

  const toolStatus = block.metadata?.rawMcpToolResponse?.status
  return Boolean(toolStatus && toolStatus !== 'done' && toolStatus !== 'error' && toolStatus !== 'cancelled')
}

const hasDeliverableContent = (block: any): boolean => {
  if (!block || block.status === MessageBlockStatus.ERROR) return false

  switch (block.type) {
    case MessageBlockType.MAIN_TEXT:
    case MessageBlockType.CODE:
    case MessageBlockType.COMPACT:
      return typeof block.content === 'string' && block.content.trim().length > 0
    case MessageBlockType.FILE:
    case MessageBlockType.IMAGE:
    case MessageBlockType.VIDEO:
    case MessageBlockType.CITATION:
      return block.status === MessageBlockStatus.SUCCESS
    default:
      return false
  }
}

const getToolTaskStatus = (block: any): (AgentTaskStatus & { status?: string; doneLabel?: string }) | undefined => {
  if (!block || block.type !== MessageBlockType.TOOL) return undefined

  const toolResponse = block.metadata?.rawMcpToolResponse
  const tool = toolResponse?.tool
  const toolName = tool?.name ?? block.toolName
  const displayInfo = getToolDisplayInfo(toolName, tool?.type === 'mcp' ? tool : undefined)
  const hasError = getToolHasError(toolResponse)
  const effectiveStatus = getEffectiveStatus(toolResponse?.status, false, hasError)
  const statusLabel = getToolStatusLabel(effectiveStatus, displayInfo, hasError)

  if (hasError) {
    const dependencyErrorLabel = getDependencyErrorLabel(toolResponse)
    return { label: dependencyErrorLabel ?? statusLabel ?? '任务处理失败', tone: 'error', status: effectiveStatus }
  }

  const tone = effectiveStatus === 'done' ? 'success' : 'running'
  return {
    label: statusLabel ?? (tone === 'success' ? displayInfo.doneLabel : displayInfo.activeLabel) ?? '正在处理任务',
    doneLabel: displayInfo.doneLabel,
    tone,
    status: effectiveStatus
  }
}

const getDependencyErrorLabel = (toolResponse: any): string | undefined => {
  const text = [
    toolResponse?.error,
    toolResponse?.content,
    toolResponse?.result,
    toolResponse?.message,
    toolResponse?.stderr,
    toolResponse?.stdout
  ]
    .map((value) => {
      if (!value) return ''
      return typeof value === 'string' ? value : JSON.stringify(value)
    })
    .join('\n')
    .toLowerCase()

  if (!text) return undefined

  if (
    text.includes('modulenotfounderror') ||
    text.includes('no module named') ||
    text.includes('cannot find module') ||
    text.includes('command not found') ||
    text.includes('is not recognized as an internal or external command') ||
    text.includes('enoent') ||
    text.includes('git bash') ||
    text.includes('git not found')
  ) {
    return '缺少运行依赖，请先修复智能助手环境'
  }

  return undefined
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
