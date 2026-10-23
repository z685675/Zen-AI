import type { Page } from '@playwright/test'
import { describe, expect, it, vi } from 'vitest'

import { sendUI } from '../electron'

function pageWith(reply: { status: string; text: string; error?: string }) {
  const element: any = {
    fill: vi.fn(),
    click: vi.fn(),
    innerText: vi.fn(async () => reply.text),
    first: () => element,
    last: () => element,
    filter: () => element
  }
  return {
    evaluate: vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 'reply', role: 'assistant', ...reply }]),
    locator: () => element
  } as unknown as Page
}

describe('quality UI terminal response detection', () => {
  it('fails immediately when a completed message has no final answer', async () => {
    await expect(sendUI(pageWith({ status: 'success', text: '  ' }), 'test', 300000)).rejects.toThrow('最终回答为空')
  })

  it('preserves the displayed error even if the message was incorrectly marked successful', async () => {
    await expect(
      sendUI(pageWith({ status: 'success', text: '', error: '上游HTTP 500' }), 'test', 300000)
    ).rejects.toThrow('上游HTTP 500')
  })

  it('stops waiting as soon as the budget gateway observes a failure', async () => {
    const page = pageWith({ status: 'processing', text: '' })
    await expect(
      sendUI(page, 'test', 300000, undefined, {
        checkFailure: () => {
          throw new Error('底层请求失败：上游HTTP 500')
        }
      })
    ).rejects.toThrow('上游HTTP 500')
    expect(page.evaluate).toHaveBeenCalledTimes(1)
  })

  it('still returns a nonempty completed response', async () => {
    await expect(sendUI(pageWith({ status: 'success', text: '完成' }), 'test', 300000)).resolves.toMatchObject({
      answer: '完成',
      messageIds: ['reply']
    })
  })
})
