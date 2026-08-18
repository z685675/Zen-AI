import { loggerService } from '@logger'
import HorizontalScrollContainer from '@renderer/components/HorizontalScrollContainer'
import Scrollbar from '@renderer/components/Scrollbar'
import { useMessageEditing } from '@renderer/context/MessageEditingContext'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { selectNewTopicLoading, useMessageOperations } from '@renderer/hooks/useMessageOperations'
import { useModel } from '@renderer/hooks/useModel'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTimer } from '@renderer/hooks/useTimer'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { getMessageModelId } from '@renderer/services/MessagesService'
import { getModelUniqId } from '@renderer/services/ModelService'
import { estimateMessageUsage } from '@renderer/services/TokenService'
import type { RootState } from '@renderer/store'
import { messageBlocksSelectors } from '@renderer/store/messageBlock'
import type { Assistant, Topic } from '@renderer/types'
import { type Message, type MessageBlock, MessageBlockType } from '@renderer/types/newMessage'
import { classNames, cn } from '@renderer/utils'
import { scrollIntoView } from '@renderer/utils/dom'
import { isMessageProcessing } from '@renderer/utils/messageUtils/is'
import { Divider } from 'antd'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { Dispatch, FC, SetStateAction } from 'react'
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSelector } from 'react-redux'
import styled from 'styled-components'

import MessageContent from './MessageContent'
import MessageEditor from './MessageEditor'
import MessageErrorBoundary from './MessageErrorBoundary'
import MessageHeader from './MessageHeader'
import MessageMenubar from './MessageMenubar'
import MessageOutline from './MessageOutline'

interface Props {
  message: Message
  topic: Topic
  assistant?: Assistant
  index?: number
  total?: number
  hideMenuBar?: boolean
  style?: React.CSSProperties
  isGrouped?: boolean
  isStreaming?: boolean
  onSetMessages?: Dispatch<SetStateAction<Message[]>>
  onUpdateUseful?: (msgId: string) => void
  isGroupContextMessage?: boolean
}

const logger = loggerService.withContext('MessageItem')

const WrapperContainer = ({
  isMultiSelectMode,
  children
}: {
  isMultiSelectMode: boolean
  children: React.ReactNode
}) => {
  return isMultiSelectMode ? <label style={{ cursor: 'pointer' }}>{children}</label> : children
}

const MessageItem: FC<Props> = ({
  message,
  topic,
  assistant: sessionAssistant,
  index,
  hideMenuBar = false,
  isGrouped,
  onUpdateUseful,
  isGroupContextMessage
}) => {
  const { t } = useTranslation()
  const { assistant: fallbackAssistant, setModel } = useAssistant(message.assistantId)
  const assistant = sessionAssistant ?? fallbackAssistant
  const { isMultiSelectMode } = useChatContext(topic)
  const model = useModel(getMessageModelId(message), message.model?.provider) || message.model
  const { messageFont, fontSize, messageStyle, showMessageOutline } = useSettings()
  const { editMessageBlocks, resendUserMessageWithEdit, editMessage } = useMessageOperations(topic)
  const messageContainerRef = useRef<HTMLDivElement>(null)
  const { editingMessageId, startEditing, stopEditing } = useMessageEditing()
  const { setTimeoutTimer } = useTimer()
  const isEditing = editingMessageId === message.id
  const topicLoading = useSelector((state: RootState) => selectNewTopicLoading(state, topic.id))
  const mainTextLength = useSelector((state: RootState) =>
    message.blocks.reduce((length, blockId) => {
      const block = messageBlocksSelectors.selectById(state, blockId)
      return block?.type === MessageBlockType.MAIN_TEXT ? length + block.content.length : length
    }, 0)
  )
  const [isCollapsed, setIsCollapsed] = useState(false)

  useEffect(() => {
    if (isEditing && messageContainerRef.current) {
      scrollIntoView(messageContainerRef.current, {
        behavior: 'smooth',
        block: 'center',
        container: 'nearest'
      })
    }
  }, [isEditing])

  const handleEditSave = useCallback(
    async (blocks: MessageBlock[]) => {
      try {
        await editMessageBlocks(message.id, blocks)
        const usage = await estimateMessageUsage(message)
        void editMessage(message.id, { usage: usage })
        stopEditing()
      } catch (error) {
        logger.error('Failed to save message blocks:', error as Error)
      }
    },
    [message, editMessageBlocks, stopEditing, editMessage]
  )

  const handleEditResend = useCallback(
    async (blocks: MessageBlock[]) => {
      try {
        await resendUserMessageWithEdit(message, blocks, assistant)
        stopEditing()
      } catch (error) {
        logger.error('Failed to resend message:', error as Error)
      }
    },
    [message, resendUserMessageWithEdit, assistant, stopEditing]
  )

  const handleEditCancel = useCallback(() => {
    stopEditing()
  }, [stopEditing])

  const isLastMessage = index === 0 || !!isGrouped
  const isAssistantMessage = message.role === 'assistant'
  const isProcessing = isMessageProcessing(message) && topicLoading
  const showMenubar = !hideMenuBar && !isEditing && !isProcessing
  const canCollapse = useMemo(() => {
    if (isEditing || isProcessing) return false

    return mainTextLength >= 600 || message.blocks.length >= 6
  }, [isEditing, isProcessing, mainTextLength, message])

  const handleCollapseToggle = useCallback(() => {
    const shouldScrollToTop = isCollapsed
    setIsCollapsed((collapsed) => !collapsed)

    if (shouldScrollToTop) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (messageContainerRef.current) {
            scrollIntoView(messageContainerRef.current, {
              behavior: 'smooth',
              block: 'start',
              container: 'nearest'
            })
          }
        })
      })
    }
  }, [isCollapsed])

  useEffect(() => {
    if (!canCollapse) {
      setIsCollapsed(false)
    }
  }, [canCollapse])

  const messageHighlightHandler = useCallback(
    (highlight: boolean = true) => {
      if (messageContainerRef.current) {
        scrollIntoView(messageContainerRef.current, { behavior: 'smooth', block: 'center', container: 'nearest' })
        if (highlight) {
          setTimeoutTimer(
            'messageHighlightHandler',
            () => {
              const classList = messageContainerRef.current?.classList
              classList?.add('animation-locate-highlight')

              const handleAnimationEnd = () => {
                classList?.remove('animation-locate-highlight')
                messageContainerRef.current?.removeEventListener('animationend', handleAnimationEnd)
              }

              messageContainerRef.current?.addEventListener('animationend', handleAnimationEnd)
            },
            500
          )
        }
      }
    },
    [setTimeoutTimer]
  )

  useEffect(() => {
    const unsubscribes = [EventEmitter.on(EVENT_NAMES.LOCATE_MESSAGE + ':' + message.id, messageHighlightHandler)]
    return () => unsubscribes.forEach((unsub) => unsub())
  }, [message.id, messageHighlightHandler])

  // Listen for external edit requests and activate editor for this message if it matches
  useEffect(() => {
    const handleEditRequest = (targetId: string) => {
      if (targetId === message.id) {
        startEditing(message.id)
      }
    }
    const unsubscribe = EventEmitter.on(EVENT_NAMES.EDIT_MESSAGE, handleEditRequest)
    return () => {
      unsubscribe()
    }
  }, [message.id, startEditing])

  if (message.type === 'clear') {
    return (
      <NewContextMessage
        isMultiSelectMode={isMultiSelectMode}
        className="clear-context-divider"
        onClick={() => {
          if (isMultiSelectMode) {
            return
          }
          void EventEmitter.emit(EVENT_NAMES.NEW_CONTEXT)
        }}>
        <Divider dashed style={{ padding: '0 20px' }} plain>
          {t('chat.message.new.context')}
        </Divider>
      </NewContextMessage>
    )
  }

  return (
    <WrapperContainer isMultiSelectMode={isMultiSelectMode}>
      <MessageContainer
        key={message.id}
        className={classNames({
          message: true,
          'message-assistant': isAssistantMessage,
          'message-user': !isAssistantMessage
        })}
        ref={messageContainerRef}>
        <MessageHeader
          message={message}
          assistant={assistant}
          model={model}
          key={getModelUniqId(model)}
          topic={topic}
          isGroupContextMessage={isGroupContextMessage}
        />
        {canCollapse && (
          <MessageCollapseBar>
            <CollapseButton
              type="button"
              aria-label={isCollapsed ? '展开此消息' : '收起此消息'}
              aria-expanded={!isCollapsed}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                handleCollapseToggle()
              }}>
              {isCollapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
              <span>{isCollapsed ? '展开此消息' : '收起此消息'}</span>
            </CollapseButton>
          </MessageCollapseBar>
        )}
        {isEditing && (
          <MessageEditor
            message={message}
            topicId={topic.id}
            onSave={handleEditSave}
            onResend={handleEditResend}
            onCancel={handleEditCancel}
          />
        )}
        {!isEditing && (
          <>
            {!isMultiSelectMode && message.role === 'assistant' && showMessageOutline && (
              <MessageOutline message={message} />
            )}
            <MessageContentContainer
              className={classNames('message-content-container', { collapsed: canCollapse && isCollapsed })}
              style={{
                fontFamily: messageFont === 'serif' ? 'var(--font-family-serif)' : 'var(--font-family)',
                fontSize,
                overflowY: 'visible'
              }}>
              <MessageErrorBoundary>
                <MessageContent message={message} isStreaming={isProcessing} />
              </MessageErrorBoundary>
            </MessageContentContainer>
            {showMenubar && (
              <MessageFooter className="MessageFooter">
                <HorizontalScrollContainer
                  classNames={{
                    content: cn(
                      'flex-1 items-center justify-between',
                      isLastMessage && messageStyle === 'plain' ? 'flex-row-reverse' : 'flex-row'
                    )
                  }}>
                  <MessageMenubar
                    message={message}
                    assistant={assistant}
                    model={model}
                    index={index}
                    topic={topic}
                    isLastMessage={isLastMessage}
                    isAssistantMessage={isAssistantMessage}
                    isGrouped={isGrouped}
                    messageContainerRef={messageContainerRef as React.RefObject<HTMLDivElement>}
                    setModel={setModel}
                    onUpdateUseful={onUpdateUseful}
                  />
                </HorizontalScrollContainer>
              </MessageFooter>
            )}
          </>
        )}
      </MessageContainer>
    </WrapperContainer>
  )
}

const MessageContainer = styled.div`
  display: flex;
  flex-direction: column;
  width: 100%;
  position: relative;
  transition: background-color 0.3s ease;
  transform: translateZ(0);
  will-change: transform;
  padding: 10px;
  padding-bottom: 0;
  border-radius: 10px;
  .menubar {
    opacity: 0;
    transition: opacity 0.2s ease;
    transform: translateZ(0);
    will-change: opacity;
    &.show {
      opacity: 1;
    }
  }
  &:hover {
    .menubar {
      opacity: 1;
    }
  }
`

const MessageContentContainer = styled(Scrollbar)`
  max-width: 100%;
  padding-left: 46px;
  margin-top: 0;
  overflow-y: auto;

  &.collapsed {
    position: relative;
    max-height: 260px;
    overflow: hidden !important;

    &::after {
      content: '';
      position: absolute;
      right: 0;
      bottom: 0;
      left: 0;
      height: 42px;
      pointer-events: none;
      background: linear-gradient(to bottom, transparent, var(--color-background));
    }
  }
`

const CollapseButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 84px;
  height: 28px;
  flex: 0 0 auto;
  padding: 0 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-icon);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;

  &:hover {
    background: var(--color-background-mute);
    color: var(--color-text-1);
  }
`

const MessageCollapseBar = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  margin-left: 46px;
  margin-top: -2px;
  margin-bottom: 2px;
`

const MessageFooter = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-left: 46px;
  margin-top: 3px;
`

const NewContextMessage = styled.div<{ isMultiSelectMode: boolean }>`
  cursor: pointer;
  flex: 1;

  ${({ isMultiSelectMode }) => isMultiSelectMode && 'cursor: default;'}
`

export default memo(MessageItem)
