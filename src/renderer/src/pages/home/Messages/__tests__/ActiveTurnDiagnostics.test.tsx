import type { Message } from '@renderer/types/newMessage'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ActiveTurnDiagnostics from '../ActiveTurnDiagnostics'

const mocks = vi.hoisted(() => ({
  export: vi.fn(),
  state: {
    messages: [{ id: 'u', role: 'user' }],
    messageBlocks: { entities: { a: { content: 'answer' } } }
  }
}))
vi.mock('@renderer/hooks/useTurnDiagnosticExport', () => ({
  useTurnDiagnosticExport: () => ({ exportTurn: mocks.export, exporting: false })
}))
vi.mock('@renderer/store', () => ({ default: { getState: () => mocks.state } }))
vi.mock('@renderer/store/newMessage', () => ({ selectMessagesForTopic: (state: typeof mocks.state) => state.messages }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe('read-only in-progress turn export', () => {
  it.each(['chat', 'agent'] as const)('exports the chosen %s turn without editing or retry actions', (source) => {
    const message = {
      id: 'a',
      askId: 'u',
      topicId: 'topic',
      role: 'assistant',
      blocks: ['a'],
      status: 'processing'
    } as Message
    render(<ActiveTurnDiagnostics message={message} source={source} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'turnDiagnostics.export' }))
    expect(mocks.export).toHaveBeenLastCalledWith({
      source,
      message,
      relatedUserMessage: mocks.state.messages[0],
      blockEntities: mocks.state.messageBlocks.entities
    })
  })
})
