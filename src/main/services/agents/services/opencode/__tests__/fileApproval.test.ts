import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ window: vi.fn(), destroyed: vi.fn(), show: vi.fn() }))
vi.mock('@main/services/WindowService', () => ({ windowService: { getMainWindow: mocks.window } }))
vi.mock('@main/utils/locales', () => ({ t: (key: string) => key }))
vi.mock('electron', () => ({ dialog: { showMessageBox: mocks.show } }))

import { confirmAssistantFileOverwrite } from '../fileApproval'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.window.mockReturnValue({ isDestroyed: mocks.destroyed })
  mocks.destroyed.mockReturnValue(false)
  mocks.show.mockResolvedValue({ response: 1 })
})
afterEach(() => vi.useRealTimers())

describe('visible file overwrite confirmation', () => {
  it('shows the exact file and requires an explicit non-default confirm', async () => {
    expect(await confirmAssistantFileOverwrite('/data/预算.xlsx', new AbortController().signal)).toBe(true)
    expect(mocks.show).toHaveBeenCalledWith(
      mocks.window(),
      expect.objectContaining({
        detail: '/data/预算.xlsx',
        defaultId: 0,
        cancelId: 0,
        buttons: ['common.cancel', 'common.confirm'],
        title: 'assistantFileSafety.title'
      })
    )
    mocks.show.mockResolvedValue({ response: 0 })
    expect(await confirmAssistantFileOverwrite('/data/预算.xlsx', new AbortController().signal)).toBe(false)
  })
  it('fails closed without an active window or after cancellation', async () => {
    const abort = new AbortController()
    abort.abort()
    expect(await confirmAssistantFileOverwrite('/data/report.xlsx', abort.signal)).toBe(false)
    mocks.window.mockReturnValue(undefined)
    expect(await confirmAssistantFileOverwrite('/data/report.xlsx', new AbortController().signal)).toBe(false)
    expect(mocks.show).not.toHaveBeenCalled()
  })
  it('cannot approve after a cancellation while the dialog is open or a dialog failure', async () => {
    const abort = new AbortController()
    mocks.show.mockImplementationOnce(async (_window, options) => {
      expect(options.signal.aborted).toBe(false)
      abort.abort()
      expect(options.signal.aborted).toBe(true)
      return { response: 1 }
    })
    expect(await confirmAssistantFileOverwrite('/data/report.xlsx', abort.signal)).toBe(false)
    mocks.show.mockRejectedValueOnce(new Error('window closed'))
    expect(await confirmAssistantFileOverwrite('/data/report.xlsx', new AbortController().signal)).toBe(false)
  })
})
