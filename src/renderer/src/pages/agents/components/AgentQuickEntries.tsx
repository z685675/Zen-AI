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
  max-width: 1040px;
  margin-top: 56px;
  padding: 18px 20px 20px;
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(255, 255, 255, 0.76);
  box-shadow:
    0 16px 40px rgba(15, 23, 42, 0.05),
    0 1px 0 rgba(255, 255, 255, 0.88) inset;
  backdrop-filter: blur(14px);

  @media (max-height: 880px) {
    margin-top: 24px;
    padding: 12px 16px 14px;
    border-radius: 24px;
  }
`

const QuickEntryLabel = styled.div`
  margin-bottom: 14px;
  font-size: 12px;
  font-weight: 600;
  color: #7d8794;
  letter-spacing: 0.04em;

  @media (max-height: 880px) {
    margin-bottom: 10px;
  }
`

const QuickEntryGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;

  @media (max-width: 1040px) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  @media (max-width: 820px) {
    grid-template-columns: 1fr;
  }
`

const QuickEntryButton = styled.button`
  display: flex;
  align-items: flex-start;
  gap: 14px;
  min-height: 92px;
  padding: 18px 18px;
  border: 1px solid rgba(245, 223, 226, 0.7);
  border-radius: 22px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(255, 250, 247, 0.9)),
    linear-gradient(135deg, rgba(255, 235, 239, 0.24), rgba(255, 245, 228, 0.24));
  box-shadow:
    0 12px 28px rgba(15, 23, 42, 0.04),
    0 1px 0 rgba(255, 255, 255, 0.92) inset;
  cursor: pointer;
  text-align: left;
  transition:
    transform 0.16s ease,
    box-shadow 0.16s ease,
    border-color 0.16s ease,
    background 0.16s ease;

  &:hover {
    transform: translateY(-1px);
    border-color: rgba(244, 114, 125, 0.28);
    box-shadow:
      0 18px 34px rgba(15, 23, 42, 0.06),
      0 1px 0 rgba(255, 255, 255, 0.94) inset;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(255, 248, 244, 0.94)),
      linear-gradient(135deg, rgba(255, 235, 239, 0.28), rgba(255, 245, 228, 0.28));
  }

  @media (max-height: 880px) {
    min-height: 76px;
    padding: 13px 16px;
  }
`

const QuickEntryIcon = styled.div`
  width: 46px;
  height: 46px;
  min-width: 46px;
  border-radius: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, rgba(255, 235, 239, 0.98), rgba(255, 245, 228, 0.98));
  color: #e25d74;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.86);
`

const QuickEntryBody = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
`

const QuickEntryTitle = styled.div`
  font-size: 15px;
  font-weight: 600;
  color: #303642;
`

const QuickEntryDescription = styled.div`
  margin-top: 5px;
  font-size: 12px;
  line-height: 1.55;
  color: #7f8896;
`
