import { Button, Tooltip } from 'antd'
import { ArrowDownToLine } from 'lucide-react'
import { type FC, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  conversationKey: string
}

const SCROLL_DISTANCE_THRESHOLD = 72

const ScrollToBottomButton: FC<Props> = ({ conversationKey }) => {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)

  const scrollToBottom = useCallback(() => {
    document.getElementById('messages')?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  useEffect(() => {
    const messagesContainer = document.getElementById('messages')
    if (!messagesContainer) {
      setVisible(false)
      return
    }

    let animationFrame: number | null = null
    const updateVisibility = () => {
      animationFrame = null
      const canScroll = messagesContainer.scrollHeight - messagesContainer.clientHeight > SCROLL_DISTANCE_THRESHOLD
      const isColumnReverse = window.getComputedStyle(messagesContainer).flexDirection === 'column-reverse'
      const distanceFromBottom = isColumnReverse
        ? Math.abs(messagesContainer.scrollTop)
        : messagesContainer.scrollHeight - messagesContainer.clientHeight - messagesContainer.scrollTop

      setVisible(canScroll && distanceFromBottom > SCROLL_DISTANCE_THRESHOLD)
    }

    const scheduleUpdate = () => {
      if (animationFrame !== null) return
      animationFrame = window.requestAnimationFrame(updateVisibility)
    }

    scheduleUpdate()
    messagesContainer.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)
    const resizeObserver = new ResizeObserver(scheduleUpdate)
    resizeObserver.observe(messagesContainer)

    return () => {
      messagesContainer.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
      resizeObserver.disconnect()
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
    }
  }, [conversationKey])

  if (!visible) return null

  return (
    <ButtonSlot>
      <Tooltip title={t('chat.navigation.bottom')} placement="top" mouseEnterDelay={0.5} mouseLeaveDelay={0}>
        <ReturnButton
          type="text"
          icon={<ArrowDownToLine size={15} strokeWidth={2} />}
          aria-label={t('chat.navigation.bottom')}
          onClick={scrollToBottom}
        />
      </Tooltip>
    </ButtonSlot>
  )
}

const ButtonSlot = styled.div`
  position: absolute;
  top: -40px;
  left: 50%;
  z-index: 5;
  display: flex;
  transform: translateX(-50%);
  align-items: center;
  justify-content: center;
  pointer-events: none;
`

const ReturnButton = styled(Button)`
  width: 30px;
  min-width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 50%;
  background: var(--color-background);
  box-shadow: 0 5px 18px rgba(0, 0, 0, 0.12);
  color: var(--color-text-2);
  pointer-events: auto;

  &:hover,
  &:focus-visible {
    border-color: var(--color-border);
    background: var(--color-background-mute) !important;
    color: var(--color-text) !important;
  }
`

export default ScrollToBottomButton
