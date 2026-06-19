import AnnouncementMarkdown from '@renderer/components/AnnouncementMarkdown'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { useAnnouncements } from '@renderer/context/AnnouncementProvider'
import { announcementService, type AnnouncementViewItem } from '@renderer/services/AnnouncementService'
import { Button, Empty } from 'antd'
import dayjs from 'dayjs'
import { diffLines } from 'diff'
import { ChevronDown, ChevronUp, FileDiff, FileText, Megaphone } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const AnnouncementMarkdownDiff: FC<{ content: string; previousContent?: string }> = ({ content, previousContent }) => {
  const changes = useMemo(() => {
    if (!previousContent || previousContent === content) {
      return null
    }

    return diffLines(previousContent, content)
  }, [content, previousContent])

  if (!changes) {
    return <AnnouncementMarkdown content={content} />
  }

  return (
    <DiffRoot>
      {changes.map((change, index) => {
        const kind = change.added ? 'added' : change.removed ? 'removed' : 'same'

        return (
          <DiffChunk key={`${kind}-${index}`} $kind={kind}>
            <AnnouncementMarkdown content={change.value} />
          </DiffChunk>
        )
      })}
    </DiffRoot>
  )
}

type AnnouncementCardItemProps = {
  item: AnnouncementViewItem
  expanded: boolean
  previousContent?: string
  highlightChangesButton: boolean
  showUpdateDot: boolean
  onAcknowledgeRead: (id: string) => void
  onAcknowledgeChange: (item: AnnouncementViewItem) => void
  onOpenLink: (url: string) => void
  onToggle: (id: string) => void
}

const AnnouncementCardItem: FC<AnnouncementCardItemProps> = ({
  item,
  expanded,
  previousContent,
  highlightChangesButton,
  showUpdateDot,
  onAcknowledgeRead,
  onAcknowledgeChange,
  onOpenLink,
  onToggle
}) => {
  const { t } = useTranslation()
  const contentRef = useRef<HTMLDivElement>(null)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [showChanges, setShowChanges] = useState(false)
  const link = item.link
  const hasContentChanges = Boolean(previousContent && previousContent !== item.content)
  const publishedAt = dayjs(item.publishedAt)
  const updatedAt = item.updatedAt ? dayjs(item.updatedAt) : null
  const hasUpdate = Boolean(updatedAt?.isValid() && publishedAt.isValid() && updatedAt.isAfter(publishedAt))
  const updatedAtText = updatedAt?.isValid() ? updatedAt.format('YYYY/MM/DD HH:mm') : ''
  const timeText = hasUpdate
    ? t('announcements.updated_at', { time: updatedAtText })
    : publishedAt.format('YYYY/MM/DD HH:mm')

  useEffect(() => {
    if (!hasContentChanges) {
      setShowChanges(false)
    }
  }, [hasContentChanges])

  const toggleChanges = useCallback(() => {
    setShowChanges((current) => {
      const next = !current
      if (next && !expanded) {
        onToggle(item.id)
      }
      if (next) {
        onAcknowledgeRead(item.id)
        onAcknowledgeChange(item)
      }
      return next
    })
  }, [expanded, item, onAcknowledgeChange, onAcknowledgeRead, onToggle])

  const toggleExpanded = useCallback(() => {
    if (!expanded) {
      onAcknowledgeRead(item.id)
    }
    onToggle(item.id)
  }, [expanded, item.id, onAcknowledgeRead, onToggle])

  useEffect(() => {
    const element = contentRef.current
    if (!element) {
      return
    }

    const updateOverflow = () => {
      setHasOverflow(element.scrollHeight > element.clientHeight + 1)
    }

    updateOverflow()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateOverflow)
      return () => window.removeEventListener('resize', updateOverflow)
    }

    const observer = new ResizeObserver(updateOverflow)
    observer.observe(element)
    return () => observer.disconnect()
  }, [expanded, item.content, showChanges])

  return (
    <AnnouncementCard>
      <CardHeader>
        <CardTitleRow>
          {showUpdateDot && <UpdatedDot />}
          <CardTitle>{item.title}</CardTitle>
        </CardTitleRow>
        <CardTime $highlight={showUpdateDot}>{timeText}</CardTime>
      </CardHeader>
      <CardContent ref={contentRef} $expanded={expanded} $showFade={!expanded && hasOverflow}>
        {showChanges ? (
          <AnnouncementMarkdownDiff content={item.content} previousContent={previousContent} />
        ) : (
          <AnnouncementMarkdown content={item.content} />
        )}
      </CardContent>
      <CardActions>
        <Button
          size="small"
          type="text"
          icon={expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          aria-expanded={expanded}
          onClick={toggleExpanded}>
          {expanded ? t('announcements.collapse') : t('announcements.expand')}
        </Button>
        {hasContentChanges && (
          <Button
            size="small"
            type={highlightChangesButton ? 'primary' : 'text'}
            danger={highlightChangesButton}
            icon={showChanges ? <FileText size={14} /> : <FileDiff size={14} />}
            onClick={toggleChanges}>
            {showChanges ? t('announcements.view_content') : t('announcements.view_changes')}
          </Button>
        )}
        {link && (
          <Button size="small" onClick={() => onOpenLink(link.url)}>
            {link.label || t('announcements.learn_more')}
          </Button>
        )}
      </CardActions>
    </AnnouncementCard>
  )
}

const AnnouncementsPage: FC = () => {
  const { t } = useTranslation()
  const { announcements, markAnnouncementsRead, refresh } = useAnnouncements()
  const [snapshots, setSnapshots] = useState(() => ({
    read: announcementService.getReadSnapshots(),
    previous: announcementService.getPreviousSnapshots(),
    changeAck: announcementService.getChangeAckVersions()
  }))
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [readAcknowledgedIds, setReadAcknowledgedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    setSnapshots({
      read: announcementService.getReadSnapshots(),
      previous: announcementService.getPreviousSnapshots(),
      changeAck: announcementService.getChangeAckVersions()
    })
    markAnnouncementsRead()
  }, [announcements, markAnnouncementsRead])

  const openLink = (url: string) => {
    void window.api.openWebsite(url)
  }

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const acknowledgeAnnouncementRead = useCallback((id: string) => {
    setReadAcknowledgedIds((current) => {
      if (current.has(id)) {
        return current
      }

      return new Set([...current, id])
    })
  }, [])

  const acknowledgeAnnouncementChange = useCallback((item: AnnouncementViewItem) => {
    const versions = announcementService.acknowledgeAnnouncementChange(item)
    setSnapshots((current) => ({
      ...current,
      changeAck: versions
    }))
  }, [])

  return (
    <PageContainer>
      <Navbar>
        <NavbarCenter>{t('announcements.title')}</NavbarCenter>
      </Navbar>
      <Content>
        <Header>
          <HeaderIcon>
            <Megaphone size={22} />
          </HeaderIcon>
          <div>
            <Title>{t('announcements.title')}</Title>
            <Subtitle>{t('announcements.subtitle')}</Subtitle>
          </div>
        </Header>

        {announcements.length === 0 ? (
          <EmptyWrapper>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('announcements.empty')} />
          </EmptyWrapper>
        ) : (
          <List>
            {announcements.map((item) => {
              const unreadSnapshot = snapshots.read[item.id]
              const hasUnreadChange = Boolean(unreadSnapshot?.content && unreadSnapshot.content !== item.content)
              const diffSnapshot =
                hasUnreadChange ||
                !snapshots.previous[item.id]?.content ||
                snapshots.previous[item.id]?.content === item.content
                  ? unreadSnapshot
                  : snapshots.previous[item.id]
              const currentVersion = announcementService.getAnnouncementVersion(item)
              const hasContentChanges = Boolean(diffSnapshot?.content && diffSnapshot.content !== item.content)
              const hasUnviewedChanges = hasContentChanges && snapshots.changeAck[item.id] !== currentVersion

              return (
                <AnnouncementCardItem
                  key={item.id}
                  item={item}
                  expanded={expandedIds.has(item.id)}
                  previousContent={diffSnapshot?.content}
                  highlightChangesButton={hasUnviewedChanges}
                  showUpdateDot={hasUnreadChange && !readAcknowledgedIds.has(item.id)}
                  onAcknowledgeRead={acknowledgeAnnouncementRead}
                  onAcknowledgeChange={acknowledgeAnnouncementChange}
                  onOpenLink={openLink}
                  onToggle={toggleExpanded}
                />
              )
            })}
          </List>
        )}
      </Content>
    </PageContainer>
  )
}

const PageContainer = styled.div`
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--color-background);
`

const Content = styled.div`
  flex: 1;
  overflow: auto;
  padding: 34px 42px 48px;
  max-width: 1120px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
`

const Header = styled.div`
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 24px;
`

const HeaderIcon = styled.div`
  width: 44px;
  height: 44px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
`

const Title = styled.div`
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text-1);
`

const Subtitle = styled.div`
  margin-top: 4px;
  font-size: 13px;
  color: var(--color-text-3);
`

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: 14px;
`

const DiffRoot = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`

const DiffChunk = styled.div<{ $kind: 'same' | 'added' | 'removed' }>`
  ${({ $kind }) =>
    $kind === 'added' &&
    `
      color: #cf1322;
      border-left: 3px solid #ff4d4f;
      padding-left: 10px;
      background: color-mix(in srgb, #ff4d4f 7%, transparent);

      strong {
        color: #cf1322;
      }
    `}

  ${({ $kind }) =>
    $kind === 'removed' &&
    `
      color: color-mix(in srgb, #cf1322 82%, var(--color-text-2));
      border-left: 3px solid color-mix(in srgb, #cf1322 48%, transparent);
      padding-left: 10px;
      background: color-mix(in srgb, #cf1322 4%, transparent);
      text-decoration: line-through;
      text-decoration-thickness: 1px;

      strong {
        color: color-mix(in srgb, #cf1322 82%, var(--color-text-2));
      }
    `}
`

const AnnouncementCard = styled.div`
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-background-soft) 82%, transparent);
  padding: 18px 20px;
`

const CardHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
`

const CardTitleRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 280px;
  min-width: 0;
`

const UpdatedDot = styled.span`
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #ff4d4f;
`

const CardTitle = styled.div`
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text-1);
  min-width: 0;
`

const CardTime = styled.div<{ $highlight: boolean }>`
  flex: 0 0 auto;
  font-size: 12px;
  color: ${({ $highlight }) => ($highlight ? '#ff4d4f' : 'var(--color-text-3)')};
  font-weight: ${({ $highlight }) => ($highlight ? 600 : 400)};
  white-space: nowrap;
`

const CardContent = styled.div<{ $expanded: boolean; $showFade: boolean }>`
  position: relative;
  margin-top: 12px;
  color: var(--color-text-2);
  user-select: text;
  max-height: ${({ $expanded }) => ($expanded ? 'none' : '180px')};
  overflow: hidden;

  ${({ $showFade }) =>
    $showFade &&
    `
      &::after {
        content: '';
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 42px;
        pointer-events: none;
        background: linear-gradient(
          to bottom,
          color-mix(in srgb, var(--color-background-soft) 0%, transparent),
          color-mix(in srgb, var(--color-background-soft) 82%, transparent)
        );
      }
    `}
`

const CardActions = styled.div`
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`

const EmptyWrapper = styled.div`
  height: 280px;
  display: flex;
  align-items: center;
  justify-content: center;
`

export default AnnouncementsPage
