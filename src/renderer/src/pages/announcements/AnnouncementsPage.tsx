import AnnouncementMarkdown from '@renderer/components/AnnouncementMarkdown'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { useAnnouncements } from '@renderer/context/AnnouncementProvider'
import { Button, Empty } from 'antd'
import dayjs from 'dayjs'
import { Megaphone } from 'lucide-react'
import type { FC } from 'react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const AnnouncementsPage: FC = () => {
  const { t } = useTranslation()
  const { announcements, markAnnouncementsRead } = useAnnouncements()

  useEffect(() => {
    markAnnouncementsRead()
  }, [markAnnouncementsRead])

  const openLink = (url: string) => {
    void window.api.openWebsite(url)
  }

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
            {announcements.map((item) => (
              <AnnouncementCard key={item.id}>
                <CardHeader>
                  <CardTitle>{item.title}</CardTitle>
                  <CardTime>{dayjs(item.publishedAt).format('YYYY/MM/DD HH:mm')}</CardTime>
                </CardHeader>
                <CardContent>
                  <AnnouncementMarkdown content={item.content} />
                </CardContent>
                {item.link && (
                  <CardAction>
                    <Button size="small" onClick={() => openLink(item.link!.url)}>
                      {item.link.label || t('announcements.learn_more')}
                    </Button>
                  </CardAction>
                )}
              </AnnouncementCard>
            ))}
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
  max-width: 760px;
  display: flex;
  flex-direction: column;
  gap: 14px;
`

const AnnouncementCard = styled.div`
  border: 1px solid var(--color-border);
  border-radius: 16px;
  background: color-mix(in srgb, var(--color-background-soft) 82%, transparent);
  padding: 18px 20px;
`

const CardHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
`

const CardTitle = styled.div`
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text-1);
`

const CardTime = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  white-space: nowrap;
`

const CardContent = styled.div`
  margin-top: 12px;
  color: var(--color-text-2);
  user-select: text;
`

const CardAction = styled.div`
  margin-top: 14px;
`

const EmptyWrapper = styled.div`
  height: 280px;
  display: flex;
  align-items: center;
  justify-content: center;
`

export default AnnouncementsPage
