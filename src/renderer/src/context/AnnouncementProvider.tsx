import AnnouncementMarkdown from '@renderer/components/AnnouncementMarkdown'
import { useNavbarPosition } from '@renderer/hooks/useSettings'
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
  refresh: () => Promise<void>
}

const AnnouncementContext = createContext<AnnouncementContextValue>({
  announcements: [],
  urgentItems: [],
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
  const footer = [
    item?.link ? (
      <Button key="link" onClick={() => openAnnouncementLink(item)}>
        {item.link.label || t('announcements.learn_more')}
      </Button>
    ) : null,
    <Button key="close" type="primary" onClick={onClose}>
      {t('common.i_know')}
    </Button>
  ].filter(Boolean)

  return (
    <Modal centered open={Boolean(item)} title={item?.title} width={520} footer={footer} onCancel={onClose}>
      {item && (
        <ModalContent>
          <ModalTime>{formatTime(item.publishedAt)}</ModalTime>
          <ModalText>
            <AnnouncementMarkdown content={item.content} />
          </ModalText>
        </ModalContent>
      )}
    </Modal>
  )
}

const UrgentBanner: FC<{ items: AnnouncementViewItem[] }> = ({ items }) => {
  const { t } = useTranslation()
  const { isTopNavbar } = useNavbarPosition()
  const fullContent = (
    <UrgentPopoverContent>
      {items.map((item) => (
        <UrgentPopoverItem key={item.id}>
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
    <UrgentBannerShell $isTopNavbar={isTopNavbar}>
      <Popover placement="bottom" content={fullContent} mouseEnterDelay={0.1}>
        <UrgentBannerInner>
          <UrgentScroller>
            {items.map((item) => (
              <UrgentMessage key={item.id}>
                <UrgentTitle>{item.title}</UrgentTitle>
                <span>{item.content}</span>
              </UrgentMessage>
            ))}
          </UrgentScroller>
        </UrgentBannerInner>
      </Popover>
    </UrgentBannerShell>
  )
}

export const AnnouncementProvider: FC<PropsWithChildren> = ({ children }) => {
  const [payload, setPayload] = useState<AnnouncementPayload | null>(() => announcementService.getCachedPayload())
  const [appVersion, setAppVersion] = useState('0.0.0')
  const [dismissedIds, setDismissedIds] = useState<string[]>(() => announcementService.getDismissedIds())
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
    }
    setActivePopup(null)
  }, [activePopup])

  return (
    <AnnouncementContext value={{ announcements, urgentItems, refresh }}>
      {children}
      <UrgentBanner items={urgentItems} />
      <AnnouncementModal item={activePopup} onClose={handleClosePopup} />
    </AnnouncementContext>
  )
}

const ModalContent = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
`

const ModalTime = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
`

const ModalText = styled.div`
  color: var(--color-text-1);
  user-select: text;
`

const scrollUrgent = keyframes`
  from {
    transform: translateX(24%);
  }
  to {
    transform: translateX(-100%);
  }
`

const UrgentBannerShell = styled.div<{ $isTopNavbar: boolean }>`
  position: fixed;
  top: 7px;
  left: ${({ $isTopNavbar }) =>
    $isTopNavbar ? '50%' : 'calc(var(--sidebar-width) + (100vw - var(--sidebar-width)) / 2)'};
  transform: translateX(-50%);
  z-index: 9998;
  width: ${({ $isTopNavbar }) =>
    $isTopNavbar
      ? 'min(380px, max(220px, calc(100vw - 360px)))'
      : 'min(460px, max(220px, calc(100vw - var(--sidebar-width) - 260px)))'};
  pointer-events: none;

  @media (max-width: 900px) {
    width: ${({ $isTopNavbar }) =>
      $isTopNavbar ? 'min(300px, calc(100vw - 220px))' : 'min(340px, calc(100vw - var(--sidebar-width) - 180px))'};
  }
`

const UrgentBannerInner = styled.div`
  height: 26px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-background) 72%, transparent);
  border: 1px solid color-mix(in srgb, #d4380d 18%, transparent);
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.08);
  backdrop-filter: blur(12px);
  overflow: hidden;
  display: flex;
  align-items: center;
  pointer-events: auto;
  cursor: default;
  -webkit-app-region: no-drag;
`

const UrgentScroller = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 36px;
  white-space: nowrap;
  animation: ${scrollUrgent} 22s linear infinite;
  padding-left: 100%;

  ${UrgentBannerInner}:hover & {
    animation-play-state: paused;
  }
`

const UrgentMessage = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #d4380d;
  font-size: 13px;
`

const UrgentTitle = styled.span`
  font-weight: 700;
`

const UrgentPopoverContent = styled.div`
  max-width: 520px;
  max-height: 260px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
`

const UrgentPopoverItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`

const UrgentPopoverTitle = styled.div`
  font-weight: 700;
  color: var(--color-text-1);
`

const UrgentPopoverText = styled.div`
  color: var(--color-text-2);
`

const UrgentLinkButton = styled(Button)`
  align-self: flex-start;
  padding: 0;
`
