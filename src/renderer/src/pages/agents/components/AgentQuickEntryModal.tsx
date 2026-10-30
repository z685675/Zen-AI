import AutomationSettings from '@renderer/pages/settings/AutomationSettings'
import SkillsSettings from '@renderer/pages/settings/SkillsSettings'
import { Modal } from 'antd'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

export type AgentQuickEntry = 'skills' | 'tasks' | 'wechat'

type AgentQuickEntryModalProps = {
  entry: AgentQuickEntry | null
  onClose: () => void
}

const AgentQuickEntryModal = ({ entry, onClose }: AgentQuickEntryModalProps) => {
  const { t } = useTranslation()

  useEffect(() => {
    const closeForTaskAction = () => onClose()
    window.addEventListener('zen-ai:close-agent-quick-entry', closeForTaskAction)
    return () => window.removeEventListener('zen-ai:close-agent-quick-entry', closeForTaskAction)
  }, [onClose])

  return (
    <Modal
      centered
      destroyOnHidden
      footer={null}
      open={entry !== null}
      onCancel={onClose}
      title={
        entry === 'skills'
          ? t('settings.skills.title')
          : entry === 'wechat'
            ? t('automation.wechat')
            : t('automation.schedule')
      }
      width="min(1220px, calc(100vw - 32px))"
      styles={{
        body: {
          height: 'calc(100vh - 160px)',
          minHeight: 0,
          overflow: 'hidden',
          padding: 0
        }
      }}>
      <div className="h-full min-h-0">
        {entry === 'skills' ? (
          <SkillsSettings embedded />
        ) : entry === 'tasks' || entry === 'wechat' ? (
          <AutomationSettings
            key={entry}
            embedded
            initialTab={entry === 'wechat' ? 'wechat' : 'schedule'}
            onNavigateToSession={onClose}
          />
        ) : null}
      </div>
    </Modal>
  )
}

export default AgentQuickEntryModal
