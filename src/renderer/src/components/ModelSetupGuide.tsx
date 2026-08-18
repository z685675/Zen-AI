import { Button } from 'antd'
import { Bot, FileUp, Settings2 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  compact?: boolean
}

const ModelSetupGuide: FC<Props> = ({ compact = false }) => {
  const { t } = useTranslation()

  const handleImport = useCallback(() => {
    window.navigate('/settings/provider?action=import')
  }, [])

  const handleOpenSettings = useCallback(() => {
    window.navigate('/settings/provider')
  }, [])

  return (
    <div
      className={
        compact
          ? 'mx-4 mb-2 flex shrink-0 items-center justify-between gap-4 rounded-xl border border-(--color-border) bg-(--color-background-soft) px-4 py-3'
          : 'flex h-full min-h-72 w-full flex-col items-center justify-center gap-4 px-6 text-center'
      }>
      <div className={compact ? 'flex min-w-0 items-center gap-3' : 'flex flex-col items-center gap-3'}>
        <Bot size={compact ? 30 : 52} strokeWidth={1.3} className="shrink-0 text-(--color-text-secondary)" />
        <div className={compact ? 'min-w-0' : ''}>
          <h3 className="m-0 font-semibold text-(--color-text) text-sm">{t('model_setup.title')}</h3>
          <p className="m-0 mt-1 max-w-lg text-(--color-text-secondary) text-xs leading-5">
            {t('model_setup.description')}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap justify-center gap-2">
        <Button type="primary" icon={<FileUp size={15} />} onClick={handleImport}>
          {t('model_setup.import')}
        </Button>
        <Button icon={<Settings2 size={15} />} onClick={handleOpenSettings}>
          {t('model_setup.open_settings')}
        </Button>
      </div>
    </div>
  )
}

export default ModelSetupGuide
