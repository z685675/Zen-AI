import { useTimer } from '@renderer/hooks/useTimer'
import { useAppDispatch } from '@renderer/store'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import { scrollIntoView } from '@renderer/utils/dom'
import { getMainTextContent } from '@renderer/utils/messageUtils/find'
import { Tooltip } from 'antd'
import { ChevronUp } from 'lucide-react'
import { type FC, useCallback, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { formatMessageAnchorPreview } from './messageAnchorUtils'

interface MessageLineProps {
  messages: Message[]
  renderedMessages?: Message[]
  onRequestMessageRender?: (message: Message) => void
}

interface ConversationTurn {
  id: string
  user?: Message
  assistants: Message[]
}

const RAIL_CONTEXT_PADDING = 28
const HOVER_NEIGHBOR_RANGE = 3

const MessageAnchorLine: FC<MessageLineProps> = ({ messages, renderedMessages, onRequestMessageRender }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const { setTimeoutTimer } = useTimer()
  const containerRef = useRef<HTMLDivElement>(null)
  const railViewportRef = useRef<HTMLDivElement>(null)
  const anchorItemsRef = useRef<Map<string, HTMLButtonElement>>(new Map())
  const [containerHeight, setContainerHeight] = useState<number | null>(null)
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null)
  const [pendingNavigationMessage, setPendingNavigationMessage] = useState<Message | null>(null)
  const [hoveredTurnIndex, setHoveredTurnIndex] = useState<number | null>(null)
  const [canScrollRailUp, setCanScrollRailUp] = useState(false)

  const orderedMessages = useMemo(
    () =>
      messages.filter(
        (message) => message.type !== 'clear' && (message.role === 'user' || message.role === 'assistant')
      ),
    [messages]
  )

  const orderedRenderedMessages = useMemo(
    () =>
      (renderedMessages ?? messages).filter(
        (message) => message.type !== 'clear' && (message.role === 'user' || message.role === 'assistant')
      ),
    [messages, renderedMessages]
  )

  const { conversationTurns, turnIdByMessageId } = useMemo(() => {
    const turns: ConversationTurn[] = []
    const messageTurnIds = new Map<string, string>()
    let currentTurn: ConversationTurn | undefined

    for (const message of orderedMessages) {
      if (message.role === 'user') {
        currentTurn = { id: message.id, user: message, assistants: [] }
        turns.push(currentTurn)
        messageTurnIds.set(message.id, currentTurn.id)
        continue
      }

      if (!currentTurn) {
        currentTurn = { id: message.id, assistants: [] }
        turns.push(currentTurn)
      }
      currentTurn.assistants.push(message)
      messageTurnIds.set(message.id, currentTurn.id)
    }

    return { conversationTurns: turns, turnIdByMessageId: messageTurnIds }
  }, [orderedMessages])

  const activeTurnId = activeMessageId ? (turnIdByMessageId.get(activeMessageId) ?? null) : null

  const handleRailWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.currentTarget.scrollHeight <= event.currentTarget.clientHeight) return

    event.stopPropagation()
  }, [])

  const scrollRailUp = useCallback(() => {
    const viewport = railViewportRef.current
    if (!viewport) return

    viewport.scrollBy({ top: -Math.max(viewport.clientHeight * 0.72, 96), behavior: 'smooth' })
  }, [])

  const setSelectedMessage = useCallback(
    (message: Message) => {
      const groupMessages = messages.filter((item) => item.askId === message.askId)
      if (groupMessages.length <= 1) return

      for (const item of groupMessages) {
        dispatch(
          newMessagesActions.updateMessage({
            topicId: item.topicId,
            messageId: item.id,
            updates: { foldSelected: item.id === message.id }
          })
        )
      }

      setTimeoutTimer(
        'setSelectedMessage',
        () => {
          const messageElement = document.getElementById(`message-${message.id}`)
          if (messageElement) {
            scrollIntoView(messageElement, { behavior: 'auto', block: 'start', container: 'nearest' })
          }
        },
        100
      )
    },
    [dispatch, messages, setTimeoutTimer]
  )

  const scrollToRenderedMessage = useCallback(
    (message: Message) => {
      const messageElement = document.getElementById(`message-${message.id}`)
      if (!messageElement) return

      if (window.getComputedStyle(messageElement).display === 'none') {
        setSelectedMessage(message)
        return
      }

      scrollIntoView(messageElement, { behavior: 'smooth', block: 'start', container: 'nearest' })
    },
    [setSelectedMessage]
  )

  const scrollToMessage = useCallback(
    (message: Message) => {
      if (document.getElementById(`message-${message.id}`)) {
        scrollToRenderedMessage(message)
        return
      }

      if (!onRequestMessageRender) return
      setPendingNavigationMessage(message)
      onRequestMessageRender(message)
    },
    [onRequestMessageRender, scrollToRenderedMessage]
  )

  useEffect(() => {
    if (!pendingNavigationMessage) return

    const animationFrame = window.requestAnimationFrame(() => {
      if (!document.getElementById(`message-${pendingNavigationMessage.id}`)) return
      scrollToRenderedMessage(pendingNavigationMessage)
      setPendingNavigationMessage(null)
    })

    return () => window.cancelAnimationFrame(animationFrame)
  }, [pendingNavigationMessage, renderedMessages, scrollToRenderedMessage])

  useEffect(() => {
    const messagesContainer = containerRef.current?.parentElement
    if (!messagesContainer) return

    const updateHeight = () => setContainerHeight(messagesContainer.clientHeight)
    updateHeight()

    const resizeObserver = new ResizeObserver(updateHeight)
    resizeObserver.observe(messagesContainer)
    return () => resizeObserver.disconnect()
  }, [])

  useEffect(() => {
    const messagesContainer = containerRef.current?.parentElement
    if (!messagesContainer || orderedRenderedMessages.length === 0) return

    let animationFrame: number | null = null
    const updateActiveMessage = () => {
      animationFrame = null
      const containerRect = messagesContainer.getBoundingClientRect()
      const targetY = containerRect.top + Math.min(containerRect.height * 0.38, 240)
      let nearestMessageId: string | null = null
      let nearestDistance = Number.POSITIVE_INFINITY

      for (const message of orderedRenderedMessages) {
        const messageElement = document.getElementById(`message-${message.id}`)
        if (!messageElement || window.getComputedStyle(messageElement).display === 'none') continue

        const rect = messageElement.getBoundingClientRect()
        if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) continue

        const distance = targetY < rect.top ? rect.top - targetY : targetY > rect.bottom ? targetY - rect.bottom : 0
        if (distance < nearestDistance) {
          nearestDistance = distance
          nearestMessageId = message.id
        }
      }

      setActiveMessageId((current) => (current === nearestMessageId ? current : nearestMessageId))
    }

    const scheduleUpdate = () => {
      if (animationFrame !== null) return
      animationFrame = window.requestAnimationFrame(updateActiveMessage)
    }

    scheduleUpdate()
    messagesContainer.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)

    return () => {
      messagesContainer.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
    }
  }, [orderedRenderedMessages])

  useEffect(() => {
    if (!activeTurnId) return

    const viewport = railViewportRef.current
    const anchor = anchorItemsRef.current.get(activeTurnId)
    if (!viewport || !anchor) return

    const itemTop = anchor.offsetTop
    const itemBottom = itemTop + anchor.offsetHeight
    if (itemTop < viewport.scrollTop + RAIL_CONTEXT_PADDING) {
      viewport.scrollTo({ top: Math.max(itemTop - RAIL_CONTEXT_PADDING, 0), behavior: 'smooth' })
    } else if (itemBottom > viewport.scrollTop + viewport.clientHeight - RAIL_CONTEXT_PADDING) {
      viewport.scrollTo({
        top: itemBottom - viewport.clientHeight + RAIL_CONTEXT_PADDING,
        behavior: 'smooth'
      })
    }
  }, [activeTurnId])

  useEffect(() => {
    const viewport = railViewportRef.current
    if (!viewport) return

    let animationFrame: number | null = null
    const updateOverflowState = () => {
      animationFrame = null
      setCanScrollRailUp(viewport.scrollTop > 4)
    }
    const scheduleUpdate = () => {
      if (animationFrame !== null) return
      animationFrame = window.requestAnimationFrame(updateOverflowState)
    }

    scheduleUpdate()
    viewport.addEventListener('scroll', scheduleUpdate, { passive: true })
    const resizeObserver = new ResizeObserver(scheduleUpdate)
    resizeObserver.observe(viewport)

    return () => {
      viewport.removeEventListener('scroll', scheduleUpdate)
      resizeObserver.disconnect()
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
    }
  }, [containerHeight, conversationTurns.length])

  if (orderedMessages.length === 0) return null

  return (
    <MessageLineContainer ref={containerRef} $height={containerHeight} onMouseLeave={() => setHoveredTurnIndex(null)}>
      <RailScrollButton
        type="button"
        $visible={canScrollRailUp}
        aria-label={t('chat.navigation.earlier')}
        aria-hidden={!canScrollRailUp}
        tabIndex={canScrollRailUp ? 0 : -1}
        onClick={scrollRailUp}>
        <ChevronUp size={14} strokeWidth={2} />
      </RailScrollButton>
      <RailViewport ref={railViewportRef} onWheel={handleRailWheel}>
        <MessagesList>
          {conversationTurns.map((turn, turnIndex) => {
            const assistantMessage = turn.assistants.find((item) => item.foldSelected) ?? turn.assistants[0]
            const targetMessage = turn.user ?? assistantMessage
            const userPreview = turn.user ? formatMessageAnchorPreview(getMainTextContent(turn.user)) : ''
            const assistantPreview = assistantMessage
              ? formatMessageAnchorPreview(getMainTextContent(assistantMessage))
              : ''
            const tooltipLabel = [userPreview, assistantPreview].filter(Boolean).join(' ')
            const isActive = activeTurnId === turn.id
            const hoverDistance =
              hoveredTurnIndex === null
                ? null
                : Math.min(Math.abs(turnIndex - hoveredTurnIndex), HOVER_NEIGHBOR_RANGE + 1)

            return (
              <Tooltip
                key={turn.id}
                placement="left"
                mouseEnterDelay={0.16}
                mouseLeaveDelay={0}
                arrow={false}
                color="var(--color-background)"
                styles={{
                  root: { maxWidth: 440 },
                  body: {
                    padding: '12px 14px',
                    border: '1px solid var(--color-border)',
                    borderRadius: 8,
                    background: 'var(--color-background)',
                    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.14)',
                    color: 'var(--color-text)'
                  }
                }}
                title={
                  tooltipLabel ? (
                    <TurnPreview>
                      {userPreview && <TurnQuestion>{userPreview}</TurnQuestion>}
                      {assistantPreview && <TurnAnswer>{assistantPreview}</TurnAnswer>}
                    </TurnPreview>
                  ) : null
                }>
                <MessageAnchorButton
                  ref={(element) => {
                    if (element) anchorItemsRef.current.set(turn.id, element)
                    else anchorItemsRef.current.delete(turn.id)
                  }}
                  type="button"
                  aria-label={tooltipLabel}
                  aria-current={isActive ? 'location' : undefined}
                  onMouseEnter={() => setHoveredTurnIndex(turnIndex)}
                  onFocus={() => setHoveredTurnIndex(turnIndex)}
                  onBlur={() => setHoveredTurnIndex(null)}
                  onClick={() => targetMessage && scrollToMessage(targetMessage)}>
                  <MessageMark $hoverDistance={hoverDistance} />
                </MessageAnchorButton>
              </Tooltip>
            )
          })}
        </MessagesList>
      </RailViewport>
    </MessageLineContainer>
  )
}

const MessageLineContainer = styled.div<{ $height: number | null }>`
  position: fixed;
  top: 50%;
  right: 12px;
  z-index: 4;
  display: flex;
  box-sizing: border-box;
  width: 42px;
  max-height: ${(props) => (props.$height ? `${Math.max(props.$height - 32, 120)}px` : 'calc(100vh - 64px)')};
  padding: 4px 0;
  transform: translateY(-50%);
  flex-direction: column;
  align-items: flex-end;
  overflow: hidden;
  user-select: none;
`

const RailScrollButton = styled.button<{ $visible: boolean }>`
  display: flex;
  width: 38px;
  min-height: 18px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-2);
  opacity: ${(props) => (props.$visible ? 0.9 : 0)};
  cursor: ${(props) => (props.$visible ? 'pointer' : 'default')};
  transition:
    color 160ms ease,
    opacity 160ms ease;
  align-items: center;
  justify-content: flex-end;
  pointer-events: ${(props) => (props.$visible ? 'auto' : 'none')};

  &:hover,
  &:focus-visible {
    color: var(--color-text);
    outline: none;
  }
`

const RailViewport = styled.div`
  width: 100%;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
  touch-action: pan-y;

  &::-webkit-scrollbar {
    display: none;
  }
`

const MessagesList = styled.div`
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
`

const MessageMark = styled.span<{ $hoverDistance: number | null }>`
  display: block;
  width: ${(props) => {
    switch (props.$hoverDistance) {
      case 0:
        return '30px'
      case 1:
        return '25px'
      case 2:
        return '21px'
      case 3:
        return '17px'
      default:
        return '13px'
    }
  }};
  height: ${(props) => (props.$hoverDistance === 0 ? '3px' : '2px')};
  border-radius: 999px;
  background: ${(props) => (props.$hoverDistance === 0 ? 'var(--color-text)' : 'var(--color-text-3)')};
  opacity: ${(props) => {
    switch (props.$hoverDistance) {
      case 0:
        return 1
      case 1:
        return 0.82
      case 2:
        return 0.7
      case 3:
        return 0.6
      default:
        return 0.52
    }
  }};
  transition:
    width 170ms cubic-bezier(0.2, 0.8, 0.2, 1),
    height 170ms ease,
    opacity 170ms ease,
    background-color 170ms ease;
`

const MessageAnchorButton = styled.button`
  display: flex;
  width: 38px;
  height: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  align-items: center;
  justify-content: flex-end;

  &:focus-visible {
    outline: none;
  }
`

const TurnPreview = styled.div`
  display: flex;
  min-width: 280px;
  max-width: 410px;
  flex-direction: column;
  gap: 7px;
`

const TurnQuestion = styled.div`
  display: -webkit-box;
  overflow: hidden;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
`

const TurnAnswer = styled.div`
  display: -webkit-box;
  overflow: hidden;
  color: var(--color-text-2);
  font-size: 13px;
  font-weight: 400;
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
`

export default MessageAnchorLine
