import { Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

export default function AgentStoppedNotice() {
  const { t } = useTranslation()
  return (
    <Notice role="status">
      <Square size={12} />
      {t('new_assistant.stopped')}
    </Notice>
  )
}
const Notice = styled.div`
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 8px 0;
  color: var(--color-text-3);
  font-size: 12px;
  line-height: 1.6;
`
