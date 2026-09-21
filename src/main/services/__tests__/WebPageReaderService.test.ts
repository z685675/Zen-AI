import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getTabTitle: vi.fn(),
  getUserAction: vi.fn(),
  waitForUser: vi.fn(),
  reset: vi.fn()
}))

vi.mock('../../mcpServers/browser/controller', () => ({
  CdpBrowserController: vi.fn(() => mocks)
}))

import { WebPageReaderService } from '../WebPageReaderService'

describe('WebPageReaderService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getUserAction.mockReturnValue(undefined)
    mocks.getTabTitle.mockReturnValue('Example')
    mocks.reset.mockResolvedValue(undefined)
  })

  it('rejects unsupported protocols before opening the browser', async () => {
    const service = new WebPageReaderService()

    await expect(service.read('file:///tmp/example.html')).rejects.toThrow('只支持 HTTP 或 HTTPS')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('reads a normal page and returns its title and content', async () => {
    mocks.fetch.mockResolvedValue({ tabId: 'tab-1', content: '网页正文' })
    const service = new WebPageReaderService()

    await expect(service.read('https://example.com/article')).resolves.toEqual({
      url: 'https://example.com/article',
      title: 'Example',
      content: '网页正文'
    })
    expect(mocks.fetch).toHaveBeenCalledWith('https://example.com/article', 'markdown', 20_000, false, false, false)
  })

  it('waits for user handoff and rereads the page after verification', async () => {
    mocks.fetch
      .mockResolvedValueOnce({ tabId: 'tab-1', content: '登录页面' })
      .mockResolvedValueOnce({ tabId: 'tab-1', content: '登录后的正文' })
    mocks.getUserAction.mockReturnValueOnce({
      tabId: 'tab-1',
      reason: 'login_required',
      message: '请登录'
    })
    mocks.waitForUser.mockResolvedValue({ status: 'continued' })

    const service = new WebPageReaderService()

    await expect(service.read('https://example.com/private')).resolves.toMatchObject({ content: '登录后的正文' })
    expect(mocks.waitForUser).toHaveBeenCalledWith('请登录', 'login_required', 15 * 60 * 1000, false, 'tab-1')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('stops with a user-facing error when the handoff is closed', async () => {
    mocks.fetch.mockResolvedValue({ tabId: 'tab-1', content: '登录页面' })
    mocks.getUserAction.mockReturnValue({ tabId: 'tab-1', reason: 'captcha', message: '请验证' })
    mocks.waitForUser.mockResolvedValue({ status: 'closed' })

    const service = new WebPageReaderService()

    await expect(service.read('https://example.com/private')).rejects.toThrow('用户关闭了网页接管操作')
  })
})
