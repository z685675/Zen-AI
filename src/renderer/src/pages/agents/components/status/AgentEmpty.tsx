import { Button } from 'antd'
import { Bot, Settings2 } from 'lucide-react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import AgentStatusScreen from './AgentStatusScreen'

const AgentEmpty = () => {
  const { t } = useTranslation()

  const handleOpenProviderSettings = useCallback(() => {
    window.navigate('/settings/provider')
  }, [])

  return (
    <AgentStatusScreen
      icon={Bot}
      iconClassName="text-(--color-text-secondary)"
      title={t('agent.empty.title')}
      description={t('agent.empty.description')}
      actions={
        <Button type="default" icon={<Settings2 size={16} />} onClick={handleOpenProviderSettings}>
          {t('agent.empty.action')}
        </Button>
      }
    />
  )
}

export default AgentEmpty
