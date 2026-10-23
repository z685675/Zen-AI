import { Alert, Button, Space } from 'antd'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import useSWR from 'swr'

export default function AutomationSessionBanner({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data, mutate } = useSWR(
    'assistant-automation-status',
    async () => {
      const response = await window.api.assistantAutomation({ action: 'status' })
      return response.ok ? response.data : undefined
    },
    { refreshInterval: 10_000, revalidateOnFocus: true }
  )
  const session = data?.sessions.find((entry) => entry.id === sessionId)
  if (!session) return null
  return (
    <Alert
      style={{ margin: '4px 12px' }}
      type={session.current ? 'info' : 'warning'}
      showIcon
      message={t(session.current ? 'automation.syncing' : 'automation.disableSync')}
      description={t('automation.scope')}
      action={
        <Space>
          {session.current && (
            <Button
              size="small"
              onClick={async () => {
                await window.api.assistantAutomation({ action: 'sync', sessionId, enabled: false })
                await mutate()
              }}>
              {t('automation.disableSync')}
            </Button>
          )}
          <Button size="small" onClick={() => navigate('/settings/assistant-automation')}>
            {t('automation.title')}
          </Button>
        </Space>
      }
    />
  )
}
