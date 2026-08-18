import { Button } from 'antd'
import { Bot, FileUp, Settings2 } from 'lucide-react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import AgentStatusScreen from './AgentStatusScreen'

const AgentEmpty = () => {
  const { t } = useTranslation()

  const handleOpenProviderSettings = useCallback(() => {
    window.navigate('/settings/provider')
  }, [])

  const handleImportProvider = useCallback(() => {
    window.navigate('/settings/provider?action=import')
  }, [])

  return (
    <AgentStatusScreen
      icon={Bot}
      iconClassName="text-(--color-text-secondary)"
      title={t('model_setup.title')}
      description={t('model_setup.description')}
      actions={
        <>
          <Button type="primary" icon={<FileUp size={16} />} onClick={handleImportProvider}>
            {t('model_setup.import')}
          </Button>
          <Button type="default" icon={<Settings2 size={16} />} onClick={handleOpenProviderSettings}>
            {t('model_setup.open_settings')}
          </Button>
        </>
      }
    />
  )
}

export default AgentEmpty
