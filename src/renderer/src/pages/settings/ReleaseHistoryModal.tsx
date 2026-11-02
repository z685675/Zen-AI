import type { ReleaseHistorySnapshot } from '@shared/releaseHistory'
import { Alert, Button, Empty, Modal, Spin, Tag } from 'antd'
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styled from 'styled-components'

export default function ReleaseHistoryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const [snapshot, setSnapshot] = useState<ReleaseHistorySnapshot>()
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const article = useRef<HTMLElement>(null)
  const generation = useRef(0)

  const applySnapshot = useCallback((next: ReleaseHistorySnapshot) => {
    setSnapshot(next)
    setSelected((previous) =>
      next.entries.some((entry) => entry.version === previous)
        ? previous
        : (next.entries.find((entry) => entry.version === next.currentVersion)?.version ??
          next.entries[0]?.version ??
          '')
    )
    setLoadFailed(false)
  }, [])

  const refresh = useCallback(
    async (force: boolean, current = generation.current) => {
      setRefreshing(true)
      try {
        const next = await window.api.releaseHistory.refresh(force)
        if (generation.current === current) applySnapshot(next)
      } catch {
        if (generation.current === current) setLoadFailed(true)
      } finally {
        if (generation.current === current) setRefreshing(false)
      }
    },
    [applySnapshot]
  )

  useEffect(() => {
    const current = ++generation.current
    if (!open) return
    setLoading(true)
    void window.api.releaseHistory
      .get()
      .then((next) => {
        if (generation.current !== current) return
        applySnapshot(next)
        setLoading(false)
        void refresh(false, current)
      })
      .catch(() => {
        if (generation.current !== current) return
        setLoading(false)
        setLoadFailed(true)
      })
    return () => {
      generation.current++
    }
  }, [open, applySnapshot, refresh])

  useEffect(() => {
    article.current?.scrollTo?.({ top: 0 })
  }, [selected])

  const entry = snapshot?.entries.find((item) => item.version === selected)
  const formatDate = (date: string) => new Date(date).toLocaleDateString(i18n.resolvedLanguage)

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={t('settings.about.releases.title')}
      width="min(1000px, calc(100vw - 32px))"
      centered
      footer={null}
      styles={{
        body: { height: 'min(70vh, 680px)', minHeight: 220, display: 'flex', flexDirection: 'column', gap: 12 }
      }}>
      <Toolbar>
        <div>
          <div>{t('settings.about.releases.localNotice')}</div>
          {snapshot?.refreshedAt && (
            <small>{t('settings.about.releases.refreshedAt', { date: formatDate(snapshot.refreshedAt) })}</small>
          )}
        </div>
        <Button
          icon={<RefreshCw size={14} />}
          loading={refreshing}
          disabled={loading}
          onClick={() => void refresh(true)}>
          {t('settings.about.releases.refresh')}
        </Button>
      </Toolbar>
      {(loadFailed || snapshot?.refreshFailed) && (
        <Alert type="warning" showIcon message={t('settings.about.releases.offlineNotice')} />
      )}
      {loading && !snapshot ? (
        <Spin style={{ margin: 'auto' }} />
      ) : snapshot?.entries.length ? (
        <HistoryLayout>
          <VersionList aria-label={t('settings.about.releases.versions')}>
            {snapshot.entries.map((item) => (
              <VersionButton
                key={item.version}
                type="button"
                aria-pressed={selected === item.version}
                onClick={() => setSelected(item.version)}>
                <strong>v{item.version}</strong>
                {item.version === snapshot.currentVersion && (
                  <Tag color="blue">{t('settings.about.releases.current')}</Tag>
                )}
                {item.releaseDate && <small>{formatDate(item.releaseDate)}</small>}
              </VersionButton>
            ))}
          </VersionList>
          <Article ref={article} aria-label={t('settings.about.releases.details')}>
            {entry && (
              <>
                <h2>v{entry.version}</h2>
                {!entry.releaseDate && <p>{t('settings.about.releases.bundledNotice')}</p>}
                <div className="markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    skipHtml
                    components={{
                      a: ({ href, children }) =>
                        href && /^https?:\/\//i.test(href) ? (
                          <a
                            href={href}
                            onClick={(event) => {
                              event.preventDefault()
                              void window.api.openWebsite(href)
                            }}>
                            {children}
                          </a>
                        ) : (
                          <span>{children}</span>
                        ),
                      img: ({ alt }) => <span>{alt}</span>
                    }}>
                    {entry.notes.trim() || t('update.noReleaseNotes')}
                  </ReactMarkdown>
                </div>
              </>
            )}
          </Article>
        </HistoryLayout>
      ) : (
        <Empty description={t('update.noReleaseNotes')} style={{ margin: 'auto' }} />
      )}
    </Modal>
  )
}

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
  color: var(--color-text-2);
  small { color: var(--color-text-3); }
`
const HistoryLayout = styled.div`
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  min-height: 0;
  flex: 1;
  gap: 18px;
  @media (max-width: 640px) { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
`
const VersionList = styled.nav`
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  padding-right: 8px;
  @media (max-width: 640px) { flex-direction: row; overflow-x: auto; padding-bottom: 6px; }
`
const VersionButton = styled.button`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
  flex-shrink: 0;
  &[aria-pressed='true'] { background: var(--color-background-soft); border-color: var(--color-primary); }
  &:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
  small { width: 100%; color: var(--color-text-3); }
  .ant-tag { margin: 0; }
`
const Article = styled.article`
  overflow: auto;
  min-width: 0;
  overflow-wrap: anywhere;
  padding: 0 12px 12px 0;
  h2 { margin-top: 0; }
  pre { overflow-x: auto; }
  table { max-width: 100%; }
`
