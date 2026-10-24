import type { Message } from '@renderer/types/newMessage'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTurnDiagnosticExport } from '../useTurnDiagnosticExport'

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), export: vi.fn(), toast: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/services/ErrorDiagnosticPackageService', () => ({
  exportErrorDiagnosticPackage: mocks.export,
  getDiagnosticAppInfo: async () => ({ version: 'test' })
}))
vi.mock('antd', () => ({
  Checkbox: ({ children, defaultChecked, onChange }: any) => (
    <label>
      <input type="checkbox" defaultChecked={defaultChecked} onChange={onChange} />
      {children}
    </label>
  )
}))
const message = { id: 'a', role: 'assistant', askId: 'u', blocks: ['answer'] } as Message
beforeEach(() => {
  vi.clearAllMocks()
  mocks.export.mockResolvedValue('/saved.zip')
  window.modal = { confirm: mocks.confirm } as any
  window.toast = { success: mocks.toast, error: mocks.toast } as any
})
describe('turn diagnostic export consent and isolation', () => {
  it.each(['chat', 'agent'] as const)('requires consent and omits content by default in %s', async (source) => {
    const { result } = renderHook(useTurnDiagnosticExport)
    act(() => result.current.exportTurn({ source, message }))
    expect(mocks.export).not.toHaveBeenCalled()
    render(mocks.confirm.mock.calls[0][0].content)
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    await act(async () => mocks.confirm.mock.calls[0][0].onOk())
    expect(mocks.export).toHaveBeenCalledWith(expect.objectContaining({ source, message, includeContent: false }))
    expect(result.current.exporting).toBe(false)
  })
  it('keeps the selected turn after navigation, exports only its blocks and honors explicit content consent', async () => {
    const { result } = renderHook(useTurnDiagnosticExport)
    act(() =>
      result.current.exportTurn({
        source: 'agent',
        message,
        relatedUserMessage: { id: 'u', blocks: ['user'] } as Message,
        blockEntities: { answer: { id: 'answer' }, user: { id: 'user' }, other: { content: 'OTHER_HISTORY' } } as any
      })
    )
    render(mocks.confirm.mock.calls[0][0].content)
    fireEvent.click(screen.getByRole('checkbox'))
    // Another click cannot replace the selected response while confirmation is open.
    act(() => result.current.exportTurn({ source: 'chat', message: { ...message, id: 'other' } }))
    expect(mocks.confirm).toHaveBeenCalledOnce()
    await act(async () => mocks.confirm.mock.calls[0][0].onOk())
    expect(mocks.export).toHaveBeenCalledWith(
      expect.objectContaining({
        message,
        includeContent: true,
        blockEntities: { answer: { id: 'answer' }, user: { id: 'user' } }
      })
    )
  })
  it('unlocks after cancel, failure or cancelling the save dialog and never replays a task', async () => {
    const { result } = renderHook(useTurnDiagnosticExport)
    act(() => result.current.exportTurn({ source: 'chat', message }))
    act(() => {
      mocks.confirm.mock.calls[0][0].onCancel()
    })
    expect(mocks.export).not.toHaveBeenCalled()
    act(() => result.current.exportTurn({ source: 'chat', message }))
    mocks.export.mockRejectedValueOnce(new Error('save failed'))
    await act(async () => mocks.confirm.mock.calls[1][0].onOk())
    expect(result.current.exporting).toBe(false)
    mocks.export.mockResolvedValueOnce('')
    act(() => result.current.exportTurn({ source: 'chat', message }))
    await act(async () => mocks.confirm.mock.calls[2][0].onOk())
    expect(result.current.exporting).toBe(false)
  })
})
