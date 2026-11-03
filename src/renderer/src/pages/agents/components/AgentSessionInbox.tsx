import { loggerService } from '@logger'
import type { AgentInboxEntry, AgentSessionInbox } from '@renderer/services/AgentSessionInboxService'
import { Button, Tag, Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('AgentSessionInboxPanel')

export function AgentSessionInboxPanel({
  entries,
  inbox,
  sessionId,
  running,
  onEdit
}: {
  entries: AgentInboxEntry[]
  inbox: AgentSessionInbox
  sessionId: string
  running: boolean
  onEdit: (entry: AgentInboxEntry) => void
}) {
  const { t } = useTranslation()
  const visible = entries.filter((entry) => entry.sessionId === sessionId && entry.state !== 'sent')
  if (!visible.length) return null
  const guideEntry = async (id: string) => {
    try {
      const result = await inbox.guide(id)
      if (result === 'queued') window.toast.info(t('agent.inbox.guideQueued'))
      if (result === 'unavailable') window.toast.info(t('agent.inbox.notReady'))
    } catch (error) {
      logger.warn('Could not promote a queued message to task guidance', { error })
      window.toast.error(t('agent.inbox.guideSaveFailed'))
    }
  }
  return (
    <section
      aria-label={t('agent.inbox.title')}
      style={{ maxHeight: 170, overflowY: 'auto', padding: '8px 12px', borderBottom: '1px solid var(--color-border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{t('agent.inbox.title')}</span>
        {visible.some((entry) => entry.state === 'queued') && (
          <Tooltip
            title={t(inbox.isPaused(sessionId) ? 'agent.inbox.resumeHint' : 'agent.inbox.pauseHint')}
            mouseEnterDelay={0.3}>
            <Button
              size="small"
              type="text"
              onClick={() => (inbox.isPaused(sessionId) ? inbox.resume(sessionId) : inbox.pause(sessionId))}>
              {t(inbox.isPaused(sessionId) ? 'agent.inbox.resume' : 'agent.inbox.pause')}
            </Button>
          </Tooltip>
        )}
      </div>
      {visible.map((entry) => (
        <div key={entry.id} style={{ paddingTop: 6 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Tag>{t(`agent.inbox.state.${entry.state}`)}</Tag>
            <span
              style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={entry.text}>
              {entry.text || t('agent.inbox.attachments')} {entry.files.length ? `(${entry.files.length})` : ''}
            </span>
            {entry.state === 'queued' && entry.delivery === 'queue' && (
              <Tooltip title={t(running ? 'agent.inbox.hint.steer' : 'agent.inbox.guideIdle')} mouseEnterDelay={0.3}>
                <span>
                  <Button size="small" type="link" disabled={!running} onClick={() => void guideEntry(entry.id)}>
                    {t('agent.inbox.steer')}
                  </Button>
                </span>
              </Tooltip>
            )}
            {['queued', 'rejected', 'deferred', 'failed'].includes(entry.state) && (
              <Button size="small" type="link" onClick={() => onEdit(entry)}>
                {t(entry.state === 'deferred' ? 'agent.inbox.continue' : 'agent.inbox.edit')}
              </Button>
            )}
            {entry.state === 'uncertain' && entry.delivery === 'steer' && (
              <Button size="small" type="link" onClick={() => void inbox.check(entry.id)}>
                {t('agent.inbox.check')}
              </Button>
            )}
            {entry.state !== 'sending' && (
              <Button
                size="small"
                type="text"
                title={t('agent.inbox.dismissHint')}
                onClick={() => inbox.remove(entry.id)}>
                {t(['queued', 'rejected'].includes(entry.state) ? 'agent.inbox.remove' : 'agent.inbox.dismiss')}
              </Button>
            )}
          </div>
          {['accepted', 'deferred', 'uncertain', 'rejected', 'failed'].includes(entry.state) && (
            <div style={{ fontSize: 12, color: 'var(--color-text-3)', paddingTop: 3 }}>
              {t(
                entry.state === 'rejected' && entry.receipt?.code === 'not_ready'
                  ? 'agent.inbox.notReady'
                  : `agent.inbox.hint.${entry.state}`
              )}
            </div>
          )}
        </div>
      ))}
    </section>
  )
}
