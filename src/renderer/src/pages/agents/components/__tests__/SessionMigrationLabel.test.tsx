import type { AgentSessionEntity } from '@renderer/types'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'assistant_transition.migrated_conversation' ? '迁移对话' : key)
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

import SessionMigrationLabel from '../SessionMigrationLabel'

const readyMetadata = {
  state: 'ready',
  source_agent_id: 'legacy-agent',
  source_session_id: 'legacy-session'
}

function makeSession(metadata?: Record<string, unknown>): Pick<AgentSessionEntity, 'agent_id' | 'configuration'> {
  return {
    agent_id: DEFAULT_OPENCODE_AGENT_ID,
    configuration: metadata ? { legacy_continuation: metadata } : undefined
  }
}

describe('migrated conversation label', () => {
  it('shows completed migrations and keeps the label after reloading saved metadata', () => {
    const session = makeSession(readyMetadata)
    const view = render(<SessionMigrationLabel session={session} />)
    expect(screen.getByText('迁移对话')).toBeInTheDocument()
    view.unmount()
    render(<SessionMigrationLabel session={JSON.parse(JSON.stringify(session))} />)
    expect(screen.getByText('迁移对话')).toBeInTheDocument()
  })

  it('does not label ordinary conversations', () => {
    const { container } = render(<SessionMigrationLabel session={makeSession()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each(['preparing', 'failed', undefined])('does not label an incomplete migration (%s)', (state) => {
    const { container } = render(<SessionMigrationLabel session={makeSession({ ...readyMetadata, state })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each(['source_agent_id', 'source_session_id'])('requires the saved %s', (field) => {
    const { container } = render(<SessionMigrationLabel session={makeSession({ ...readyMetadata, [field]: '' })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('does not label the original legacy conversation', () => {
    const session = { ...makeSession(readyMetadata), agent_id: 'legacy-agent' }
    const { container } = render(<SessionMigrationLabel session={session} />)
    expect(container).toBeEmptyDOMElement()
  })
})
