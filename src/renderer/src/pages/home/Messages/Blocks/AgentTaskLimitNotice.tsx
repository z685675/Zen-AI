import { Hourglass } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

export default function AgentTaskLimitNotice({ limit }: { limit: number }) {
  const { t } = useTranslation()
  return (
    <Notice role="status">
      <Hourglass size={14} />
      <span>{t('agent.task_limit', { limit })}</span>
    </Notice>
  )
}

const Notice = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 8px 0;
  color: var(--color-text-2);
  font-size: 12px;
  line-height: 1.6;

  svg {
    flex-shrink: 0;
    margin-top: 3px;
  }
`
