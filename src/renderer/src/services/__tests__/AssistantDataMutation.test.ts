import { describe, expect, it, vi } from 'vitest'
vi.mock('@renderer/i18n', () => ({ default: { t: (key: string) => key } }))
import { runAssistantDataMutation } from '../AssistantDataMutation'
describe('renderer data mutation lease', () => {
  it('does not touch databases/files or show success when main denies admission', async () => {
    const work = vi.fn()
    window.api = {
      backup: { beginDataOperation: vi.fn(async () => ({ success: false })), endDataOperation: vi.fn() }
    } as any
    window.toast = { info: vi.fn() } as any
    await runAssistantDataMutation('reset', work)
    expect(work).not.toHaveBeenCalled()
    expect(window.api.backup.endDataOperation).not.toHaveBeenCalled()
    expect(window.toast.info).toHaveBeenCalledWith('assistantDataSafety.busy')
  })
  it.each([false, true])('always releases the exact lease and reports commit truthfully (failure=%s)', async (fail) => {
    window.api = {
      backup: { beginDataOperation: vi.fn(async () => ({ success: true, token: 'chosen' })), endDataOperation: vi.fn() }
    } as any
    const pending = runAssistantDataMutation('restore', async () => {
      if (fail) throw new Error('parse failed')
      return 'done'
    })
    if (fail) await expect(pending).rejects.toThrow('parse failed')
    else expect(await pending).toBe('done')
    expect(window.api.backup.endDataOperation).toHaveBeenCalledExactlyOnceWith('chosen', !fail)
  })
})
