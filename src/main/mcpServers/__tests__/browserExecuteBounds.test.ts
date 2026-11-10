import { describe, expect, it, vi } from 'vitest'

import type { CdpBrowserController } from '../browser/controller'
import { handleExecute } from '../browser/tools/execute'

describe('browser execute extraction boundary', () => {
  it('bounds a large page result without executing the script twice', async () => {
    const execute = vi.fn(async () => 'x'.repeat(45000))
    const controller = {
      execute,
      waitForUserActionDetection: vi.fn(async () => undefined)
    } as unknown as CdpBrowserController
    const result = await handleExecute(controller, { code: 'document.body.innerText', maxChars: 1000 })
    const payload = JSON.parse((result.content[0] as { text: string }).text)
    expect(payload).toMatchObject({ truncated: true, totalChars: 45000 })
    expect(payload.preview).toHaveLength(1000)
    expect(execute).toHaveBeenCalledOnce()
    expect(result.isError).toBe(false)
  })
})
