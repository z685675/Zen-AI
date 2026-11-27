import { useAgentWorkspace } from '@renderer/context/AgentWorkspaceProvider'
import { CalendarClock, MessageCircle, Puzzle } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import AgentQuickEntryModal, { type AgentQuickEntry } from './AgentQuickEntryModal'

export default function AgentQuickEntries() {
  const { t } = useTranslation()
  const workspace = useAgentWorkspace()
  const [entry, setEntry] = useState<AgentQuickEntry | null>(null)

  if (workspace !== 'opencode') return null

  const items = [
    {
      key: 'wechat',
      title: t('automation.wechat'),
      description: t('agent.welcome.quick_entries.wechat_desc'),
      icon: <MessageCircle size={19} />
    },
    {
      key: 'tasks',
      title: t('automation.schedule'),
      description: t('agent.welcome.quick_entries.tasks_desc'),
      icon: <CalendarClock size={19} />
    },
    {
      key: 'skills',
      title: t('settings.skills.title'),
      description: t('agent.welcome.quick_entries.skills_desc'),
      icon: <Puzzle size={19} />
    }
  ] as const

  return (
    <>
      <QuickEntrySection>
        <QuickEntryLabel>{t('agent.welcome.quick_entries.title')}</QuickEntryLabel>
        <QuickEntryGrid>
          {items.map((item) => (
            <QuickEntryButton key={item.key} type="button" onClick={() => setEntry(item.key)}>
              <QuickEntryIcon>{item.icon}</QuickEntryIcon>
              <QuickEntryBody>
                <QuickEntryTitle>{item.title}</QuickEntryTitle>
                <QuickEntryDescription>{item.description}</QuickEntryDescription>
              </QuickEntryBody>
            </QuickEntryButton>
          ))}
        </QuickEntryGrid>
      </QuickEntrySection>
      <AgentQuickEntryModal entry={entry} onClose={() => setEntry(null)} />
    </>
  )
}

const QuickEntrySection = styled.div`
  width: 100%;
  margin-top: 28px;
`

const QuickEntryLabel = styled.div`
  margin-bottom: 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--zen-text-3);
  letter-spacing: 0.02em;
`

const QuickEntryGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;

  @media (max-width: 720px) {
    grid-template-columns: 1fr;
  }
`

const QuickEntryButton = styled.button`
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-height: 74px;
  padding: 14px 16px;
  border: 0;
  border-radius: var(--zen-radius-md);
  background: var(--zen-glass-card);
  backdrop-filter: blur(24px) saturate(160%);
  box-shadow: var(--zen-shadow-card);
  cursor: pointer;
  text-align: left;
  transition:
    background 160ms ease,
    box-shadow 180ms ease,
    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);

  &:hover {
    background: var(--zen-glass-pill-hover);
    box-shadow: var(--zen-shadow-pill-hover);
    transform: translateY(-1px);
  }
`

const QuickEntryIcon = styled.div`
  width: 34px;
  height: 34px;
  min-width: 34px;
  border-radius: var(--zen-radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--zen-bg-subtle);
  color: var(--zen-text-2);

  svg {
    width: 16px;
    height: 16px;
  }
`

const QuickEntryBody = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
`

const QuickEntryTitle = styled.div`
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  color: var(--zen-text-1);
`

const QuickEntryDescription = styled.div`
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--zen-text-2);
`
