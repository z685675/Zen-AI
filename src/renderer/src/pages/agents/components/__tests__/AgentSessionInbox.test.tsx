import zhCN from '@renderer/i18n/locales/zh-cn.json'
import type { AgentInboxEntry, AgentSessionInbox } from '@renderer/services/AgentSessionInboxService'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentSessionInboxPanel } from '../AgentSessionInbox'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key.split('.').reduce((value: any, part) => value?.[part], zhCN) || key
  })
}))

const entry = {
  id: 'queued-message',
  sessionId: 'session',
  delivery: 'queue',
  state: 'queued',
  text: '先查近三年的文献，再整理结论',
  files: [],
  args: []
} as unknown as AgentInboxEntry

function fixture(entries: AgentInboxEntry[] = [entry], running = true) {
  const guide = vi.fn().mockResolvedValue('submitted')
  const remove = vi.fn()
  const onEdit = vi.fn()
  const inbox = { guide, remove, isPaused: () => false } as unknown as AgentSessionInbox
  render(
    <AgentSessionInboxPanel entries={entries} inbox={inbox} sessionId="session" running={running} onEdit={onEdit} />
  )
  return { guide, remove, onEdit }
}

beforeEach(() => {
  window.toast = { info: vi.fn(), error: vi.fn() } as any
})

describe('queued message guidance', () => {
  it('puts the guide button beside the sent queued message and explains it on hover', async () => {
    const { guide, remove, onEdit } = fixture()
    expect(screen.getByText(entry.text)).toBeInTheDocument()
    const button = screen.getByRole('button', { name: /引\s*导/ })
    fireEvent.mouseEnter(button.parentElement!)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(zhCN.agent.inbox.hint.steer)
    fireEvent.click(button)
    await waitFor(() => expect(guide).toHaveBeenCalledWith(entry.id))
    expect(remove).not.toHaveBeenCalled()
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('disables guiding without a running task and explains why on hover', async () => {
    fixture([entry], false)
    const button = screen.getByRole('button', { name: /引\s*导/ })
    expect(button).toBeDisabled()
    fireEvent.mouseEnter(button.parentElement!)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(zhCN.agent.inbox.guideIdle)
  })

  it('does not offer guiding for messages already being sent or handled, or another session', () => {
    fixture([
      { ...entry, id: 'sending', delivery: 'steer', state: 'sending' },
      { ...entry, id: 'accepted', delivery: 'steer', state: 'accepted' },
      { ...entry, id: 'other', sessionId: 'another-session' }
    ])
    expect(screen.queryByRole('button', { name: /引\s*导/ })).not.toBeInTheDocument()
  })

  it('explains that a definitely unsubmitted guide remains queued', async () => {
    const { guide, remove } = fixture()
    guide.mockResolvedValueOnce('queued')
    fireEvent.click(screen.getByRole('button', { name: /引\s*导/ }))
    await waitFor(() => expect(window.toast.info).toHaveBeenCalledWith(zhCN.agent.inbox.guideQueued))
    expect(screen.getByText(entry.text)).toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()
  })

  it('reports a save failure without discarding or moving the queued message into the draft', async () => {
    const { guide, remove, onEdit } = fixture()
    guide.mockRejectedValueOnce(new Error('storage full'))
    fireEvent.click(screen.getByRole('button', { name: /引\s*导/ }))
    await waitFor(() => expect(window.toast.error).toHaveBeenCalledWith(zhCN.agent.inbox.guideSaveFailed))
    expect(remove).not.toHaveBeenCalled()
    expect(onEdit).not.toHaveBeenCalled()
  })
})
