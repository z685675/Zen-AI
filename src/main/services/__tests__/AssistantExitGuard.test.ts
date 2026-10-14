import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }))
vi.mock('@main/utils/locales', () => ({ t: (key: string) => key }))
vi.mock('../agents/services/opencode/process', () => ({ hasActiveOpenCodeTask: () => false }))
vi.mock('../agents/services/sessionActivity', () => ({ activeSessionTaskCount: () => 0 }))

import { createAssistantExitGuard } from '../AssistantExitGuard'

describe('assistant quit admission', () => {
  it('does not prompt without active work', async () => {
    const confirm = vi.fn()
    expect(await createAssistantExitGuard(() => false, confirm)()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
  it.each([true, false])('uses the explicit decision, never latching a cancelled exit (%s)', async (decision) => {
    const confirm = vi.fn().mockReturnValueOnce(decision).mockReturnValue(true)
    const allow = createAssistantExitGuard(() => true, confirm)
    expect(await allow()).toBe(decision)
    expect(await allow()).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(2)
  })
  it('fails closed on native dialog failure but allows a later decision', async () => {
    const confirm = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('dialog failure')
      })
      .mockReturnValue(true)
    const allow = createAssistantExitGuard(() => true, confirm)
    expect(await allow()).toBe(false)
    expect(await allow()).toBe(true)
  })
  it('shares one non-blocking confirmation across concurrent quit attempts', async () => {
    let resolve: (value: boolean) => void = () => undefined
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done
        })
    )
    const allow = createAssistantExitGuard(() => true, confirm)
    const first = allow(),
      second = allow()
    expect(first).toBe(second)
    await Promise.resolve()
    expect(confirm).toHaveBeenCalledOnce()
    resolve(false)
    expect(await first).toBe(false)
    expect(await second).toBe(false)
  })
})
