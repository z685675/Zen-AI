import { describe, expect, it, vi } from 'vitest'

import type { CdpBrowserController } from '../browser/controller'
import { handleWaitForUser } from '../browser/tools/waitForUser'

describe('browser human verification wait', () => {
  it('keeps the detected tab/reason and gives a human at least five minutes, even when the model asks for one', async () => {
    const waitForUser = vi.fn(async () => ({ status: 'continued', tabId: 'verified-tab' }))
    const controller = {
      getAutomationHandoff: () => ({ tabId: 'verified-tab', userAction: { reason: 'captcha' } }),
      waitForUser
    } as unknown as CdpBrowserController
    const result = await handleWaitForUser(controller, { reason: '请完成验证', timeout: 60_000 })
    expect(waitForUser).toHaveBeenCalledWith(undefined, 'captcha', 300_000, false, 'verified-tab')
    expect(result.isError).toBe(false)
  })

  it('reports an unfinished verification explicitly without claiming page retrieval or successful handoff', async () => {
    const controller = {
      getAutomationHandoff: () => undefined,
      waitForUser: vi.fn().mockRejectedValue(new Error('Timed out waiting for user'))
    } as unknown as CdpBrowserController
    const result = await handleWaitForUser(controller, {})
    expect(result.isError).toBe(false)
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: 'timed_out',
      service: 'Zen browser handoff',
      executed: false
    })
  })

  it('rejects invalid wait durations before opening a handoff', async () => {
    const waitForUser = vi.fn()
    const controller = { waitForUser } as unknown as CdpBrowserController
    for (const timeout of [-1, 0, Infinity, 31 * 60_000]) {
      expect((await handleWaitForUser(controller, { timeout })).isError).toBe(true)
    }
    expect(waitForUser).not.toHaveBeenCalled()
  })
})
