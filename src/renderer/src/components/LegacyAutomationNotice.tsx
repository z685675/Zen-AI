import { Alert } from 'antd'
import { useTranslation } from 'react-i18next'

export default function LegacyAutomationNotice() {
  const { t } = useTranslation()
  return (
    <div style={{ padding: 24, flex: 1 }}>
      <Alert type="info" showIcon message={t('assistant_transition.legacy_automation_disabled')} />
    </div>
  )
}
