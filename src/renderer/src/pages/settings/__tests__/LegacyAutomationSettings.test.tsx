import { render, screen } from '@testing-library/react'
import type * as ReactI18next from 'react-i18next'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@renderer/hooks/agents/useChannels', () => ({ useChannels: vi.fn() }))
vi.mock('@renderer/hooks/agents/useAgentClient', () => ({ useAgentClient: vi.fn() }))
vi.mock('@renderer/hooks/agents/useModels', () => ({ useApiModels: vi.fn() }))
vi.mock('@renderer/hooks/agents/useTasks', () => ({ useTaskLogs: vi.fn() }))
vi.mock('../ChannelsSettings/ChannelDetail', () => ({
  default: () => {
    throw new Error('Disabled channel UI mounted')
  }
}))

import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import { useChannels } from '@renderer/hooks/agents/useChannels'

import ChannelsSettings from '../ChannelsSettings'
import TasksSettings from '../TasksSettings'

describe('retired automation settings/deep links', () => {
  it.each([ChannelsSettings, TasksSettings])(
    'renders a shutdown notice without mounting active controls',
    (Component) => {
      render(<Component />)
      expect(screen.getByText('assistant_transition.legacy_automation_disabled')).toBeInTheDocument()
      expect(useChannels).not.toHaveBeenCalled()
      expect(useAgentClient).not.toHaveBeenCalled()
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    }
  )
})
