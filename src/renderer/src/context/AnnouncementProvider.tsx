import AnnouncementMarkdown from '@renderer/components/AnnouncementMarkdown'
import { announcementService, type AnnouncementViewItem } from '@renderer/services/AnnouncementService'
import type { AnnouncementPayload } from '@renderer/types/announcement'
import { Button, Modal, Popover } from 'antd'
import dayjs from 'dayjs'
import type { FC, PropsWithChildren } from 'react'
import { createContext, use, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled, { keyframes } from 'styled-components'

const POLL_INTERVAL = 5 * 60 * 1000

type AnnouncementContextValue = {
  announcements: AnnouncementViewItem[]
  urgentItems: AnnouncementViewItem[]
  unreadCount: number
  markAnnouncementsRead: () => void
  refresh: () => Promise<void>
}

const AnnouncementContext = createContext<AnnouncementContextValue>({
  announcements: [],
  urgentItems: [],
  unreadCount: 0,
  markAnnouncementsRead: () => undefined,
  refresh: async () => undefined
})

export const useAnnouncements = () => use(AnnouncementContext)

const formatTime = (value: string) => dayjs(value).format('YYYY/MM/DD HH:mm')

const getLinkUrl = (item: AnnouncementViewItem) => item.link?.url

const openAnnouncementLink = (item: AnnouncementViewItem) => {
  const url = getLinkUrl(item)
  if (!url) return

  void window.api.openWebsite(url)
}

const AnnouncementModal: FC<{
  item: AnnouncementViewItem | null
  onClose: () => void
}> = ({ item, onClose }) => {
  const { t } = useTranslation()

  return (
    <Modal
      centered
      open={Boolean(item)}
      title={null}
      width="min(80vw, calc(100vw - 48px))"
      footer={null}
      onCancel={onClose}
      styles={{
        content: {
          padding: 0,
          overflow: 'hidden',
          borderRadius: 'var(--zen-radius-xl)',
          background: 'var(--zen-glass-rail)',
          backdropFilter: 'blur(36px) saturate(165%)',
          boxShadow: 'var(--zen-shadow-composer)'
        },
        body: { padding: 0, maxHeight: 'none', overflow: 'hidden' }
      }}>
      {item && (
        <AnnouncementModalShell>
          <AnnouncementModalHeader>
            <AnnouncementMetaRow>
              <AnnouncementBadge>{t('announcements.title', '系统公告')}</AnnouncementBadge>
              <ModalTime>{formatTime(item.publishedAt)}</ModalTime>
            </AnnouncementMetaRow>
            <AnnouncementModalTitle>{item.title}</AnnouncementModalTitle>
          </AnnouncementModalHeader>
          <AnnouncementModalBody>
            <ModalText>
              <AnnouncementMarkdown content={item.content} />
            </ModalText>
          </AnnouncementModalBody>
          <AnnouncementModalFooter>
            {item.link && (
              <Button shape="round" onClick={() => openAnnouncementLink(item)}>
                {item.link.label || t('announcements.learn_more')}
              </Button>
            )}
            <Button shape="round" type="primary" onClick={onClose}>
              {t('common.i_know')}
            </Button>
          </AnnouncementModalFooter>
        </AnnouncementModalShell>
      )}
    </Modal>
  )
}

const UrgentBanner: FC<{ items: AnnouncementViewItem[] }> = ({ items }) => {
  const { t } = useTranslation()
  const fullContent = (
    <UrgentPopoverContent>
      {items.map((item) => (
        <UrgentPopoverItem key={item.id}>
          <UrgentPopoverHeader>
            <UrgentPopoverBadge>
              <UrgentDot aria-hidden="true" />
              <span>{t('announcements.urgent_badge', '紧急公告')}</span>
            </UrgentPopoverBadge>
            <UrgentPopoverTime>{formatTime(item.publishedAt)}</UrgentPopoverTime>
          </UrgentPopoverHeader>
          <UrgentPopoverTitle>{item.title}</UrgentPopoverTitle>
          <UrgentPopoverText>
            <AnnouncementMarkdown content={item.content} compact />
          </UrgentPopoverText>
          {item.link && (
            <UrgentLinkButton type="link" size="small" onClick={() => openAnnouncementLink(item)}>
              {item.link.label || t('announcements.learn_more')}
            </UrgentLinkButton>
          )}
        </UrgentPopoverItem>
      ))}
    </UrgentPopoverContent>
  )

  if (items.length === 0) {
    return null
  }

  return (
    <UrgentBannerShell role="status" aria-live="polite">
      <Popover placement="bottom" content={fullContent} mouseEnterDelay={0.12}>
        <UrgentBannerInner>
          <UrgentBadge>
            <UrgentDot aria-hidden="true" />
            <span>{t('announcements.urgent_short', '紧急')}</span>
          </UrgentBadge>
          <UrgentTrack>
            <UrgentScroller>
              {items.map((item) => (
                <UrgentMessage key={item.id}>
                  <UrgentTitle>{item.title}</UrgentTitle>
                  <UrgentBody>{item.content}</UrgentBody>
                </UrgentMessage>
              ))}
            </UrgentScroller>
          </UrgentTrack>
        </UrgentBannerInner>
      </Popover>
    </UrgentBannerShell>
  )
}

export const AnnouncementProvider: FC<PropsWithChildren> = ({ children }) => {
  const [payload, setPayload] = useState<AnnouncementPayload | null>(() => announcementService.getCachedPayload())
  const [appVersion, setAppVersion] = useState('0.0.0')
  const [dismissedIds, setDismissedIds] = useState<string[]>(() => announcementService.getDismissedIds())
  const [readVersionTick, setReadVersionTick] = useState(0)
  const [activePopup, setActivePopup] = useState<AnnouncementViewItem | null>(null)

  const refresh = useCallback(async () => {
    try {
      const nextPayload = await announcementService.fetchPayload()
      if (nextPayload) {
        setPayload(nextPayload)
      } else {
        setPayload(null)
      }
    } catch {
      const cachedPayload = announcementService.getCachedPayload()
      if (cachedPayload) {
        setPayload(cachedPayload)
      }
    }
  }, [])

  useEffect(() => {
    void window.api.getAppInfo().then((info) => {
      setAppVersion(info.version)
    })
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL)
    return () => window.clearInterval(timer)
  }, [refresh])

  const visibleItems = useMemo(() => announcementService.filterItems(payload, appVersion), [payload, appVersion])

  const announcements = useMemo(() => announcementService.getLatestAnnouncements(visibleItems, 3), [visibleItems])
  const urgentItems = useMemo(() => announcementService.getUrgentItems(visibleItems), [visibleItems])
  const unreadCount = useMemo(() => {
    void readVersionTick
    return announcementService.getUnreadCount(announcements)
  }, [announcements, readVersionTick])

  useEffect(() => {
    if (activePopup) {
      return
    }

    const nextPopup = announcements.find((item) => !dismissedIds.includes(item.id))
    if (nextPopup) {
      setActivePopup(nextPopup)
    }
  }, [activePopup, announcements, dismissedIds])

  const handleClosePopup = useCallback(() => {
    if (activePopup) {
      setDismissedIds(announcementService.dismissAnnouncement(activePopup.id))
      announcementService.markAnnouncementsRead([activePopup])
      setReadVersionTick((tick) => tick + 1)
    }
    setActivePopup(null)
  }, [activePopup])

  const markAnnouncementsRead = useCallback(() => {
    announcementService.markAnnouncementsRead(announcements)
    setReadVersionTick((tick) => tick + 1)
  }, [announcements])

  return (
    <AnnouncementContext value={{ announcements, urgentItems, unreadCount, markAnnouncementsRead, refresh }}>
      {children}
      <UrgentBanner items={urgentItems} />
      <AnnouncementModal item={activePopup} onClose={handleClosePopup} />
    </AnnouncementContext>
  )
}

const AnnouncementModalShell = styled.div`
  display: flex;
  flex-direction: column;
  height: min(80vh, calc(100dvh - 48px));
  max-height: calc(100dvh - 48px);
  background: var(--zen-window-canvas);
  color: var(--zen-text-1);
`

const AnnouncementModalHeader = styled.div`
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 22px 56px 16px 26px;
  border-bottom: 0.5px solid var(--zen-border);
`

const AnnouncementMetaRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
`

const AnnouncementBadge = styled.span`
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 10px;
  border-radius: var(--zen-radius-pill);
  background: var(--zen-glass-pill);
  box-shadow: var(--zen-shadow-active);
  font-size: 11px;
  font-weight: 600;
  color: var(--zen-text-2);
`

const AnnouncementModalTitle = styled.h3`
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.02em;
  color: var(--zen-text-1);
`

const AnnouncementModalBody = styled.div`
  flex: 1;
  min-height: 0;
  padding: 20px 26px;
  overflow-y: auto;
`

const AnnouncementModalFooter = styled.div`
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 26px 18px;
  border-top: 0.5px solid var(--zen-border);
`

const ModalTime = styled.div`
  font-family: var(--code-font-family);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--zen-text-3);
`

const ModalText = styled.div`
  font-size: 13.5px;
  line-height: 1.75;
  color: var(--zen-text-2);
  user-select: text;

  strong {
    color: var(--zen-text-1);
  }
`

const scrollUrgent = keyframes`
  from {
    transform: translateX(0%);
  }
  to {
    transform: translateX(-100%);
  }
`

const pulseUrgent = keyframes`
  0%, 100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--zen-danger) 42%, transparent);
  }
  50% {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--zen-danger) 0%, transparent);
  }
`

const UrgentBannerShell = styled.div`
  position: fixed;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9998;
  width: min(420px, max(150px, calc(100vw - 680px)));
  pointer-events: none;

  @media (max-width: 960px) {
    width: min(240px, max(140px, calc(100vw - 600px)));
  }
`

const UrgentBannerInner = styled.div`
  height: 30px;
  padding: 0 10px 0 6px;
  border-radius: var(--zen-radius-pill);
  background:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--zen-danger) 7%, transparent) 0%,
      transparent 38%
    ),
    var(--zen-glass-pill);
  backdrop-filter: blur(28px) saturate(165%);
  -webkit-backdrop-filter: blur(28px) saturate(165%);
  box-shadow:
    0 0 0 0.75px color-mix(in srgb, var(--zen-danger) 24%, transparent),
    var(--zen-shadow-pill);
  overflow: hidden;
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: auto;
  cursor: pointer;
  -webkit-app-region: no-drag;
  transition:
    background 160ms ease,
    box-shadow 180ms ease,
    transform 150ms ease;

  &:hover {
    background:
      linear-gradient(
        90deg,
        color-mix(in srgb, var(--zen-danger) 9%, transparent) 0%,
        transparent 38%
      ),
      var(--zen-glass-pill-hover);
    box-shadow:
      0 0 0 0.75px color-mix(in srgb, var(--zen-danger) 32%, transparent),
      var(--zen-shadow-pill-hover);
    transform: translateY(-0.5px);
  }
`

const UrgentBadge = styled.span`
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 8px 0 7px;
  border-radius: var(--zen-radius-pill);
  background: color-mix(in srgb, var(--zen-danger) 12%, transparent);
  color: var(--zen-danger);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
`

const UrgentDot = styled.span`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--zen-danger);
  flex: none;
  animation: ${pulseUrgent} 2.2s ease-in-out infinite;
`

const UrgentTrack = styled.div`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  mask-image: linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 14px), transparent);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 14px), transparent);
`

const UrgentScroller = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 36px;
  white-space: nowrap;
  animation: ${scrollUrgent} 20s linear infinite;
  padding-left: 100%;

  ${UrgentBannerInner}:hover & {
    animation-play-state: paused;
  }
`

const UrgentMessage = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 1;
`

const UrgentTitle = styled.span`
  font-weight: 600;
  color: var(--zen-text-1);
`

const UrgentBody = styled.span`
  color: var(--zen-text-2);
`

const UrgentPopoverContent = styled.div`
  max-width: 440px;
  max-height: 280px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 2px;
`

const UrgentPopoverItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;

  & + & {
    padding-top: 10px;
    border-top: 0.5px solid var(--zen-border);
  }
`

const UrgentPopoverHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
`

const UrgentPopoverBadge = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: var(--zen-radius-pill);
  background: color-mix(in srgb, var(--zen-danger) 12%, transparent);
  color: var(--zen-danger);
  font-size: 11px;
  font-weight: 600;
`

const UrgentPopoverTime = styled.span`
  font-family: var(--code-font-family);
  font-size: 11px;
  color: var(--zen-text-3);
  font-variant-numeric: tabular-nums;
`

const UrgentPopoverTitle = styled.div`
  font-size: 13.5px;
  font-weight: 600;
  color: var(--zen-text-1);
`

const UrgentPopoverText = styled.div`
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--zen-text-2);
`

const UrgentLinkButton = styled(Button)`
  align-self: flex-start;
  padding: 0;
`
