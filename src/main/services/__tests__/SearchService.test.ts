import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  executeJavaScript: vi.fn(),
  isDestroyed: vi.fn(),
  loadURL: vi.fn(),
  netFetch: vi.fn(),
  on: vi.fn(),
  show: vi.fn(),
  stop: vi.fn(),
  webContents: {
    executeJavaScript: vi.fn(),
    stop: vi.fn(),
    userAgent: ''
  }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ debug: vi.fn() })
  }
}))
vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor() {
      return {
        close: mocks.close,
        isDestroyed: mocks.isDestroyed,
        loadURL: mocks.loadURL,
        on: mocks.on,
        show: mocks.show,
        webContents: mocks.webContents
      }
    }
  },
  net: {
    fetch: mocks.netFetch
  }
}))

import { isAllowedSearchResourceUrl, SEARCH_PAGE_LOAD_TIMEOUT_MS, SearchService } from '../SearchService'

describe('SearchService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.isDestroyed.mockReturnValue(false)
    mocks.loadURL.mockResolvedValue(undefined)
    mocks.webContents.executeJavaScript.mockResolvedValue('<html><body>ready</body></html>')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('extracts content shortly after loadURL completes without a second load wait', async () => {
    const service = new SearchService()
    const resultPromise = service.openUrlInSearchWindow('search-1', 'https://example.com')

    await vi.advanceTimersByTimeAsync(350)

    await expect(resultPromise).resolves.toBe('<html><body>ready</body></html>')
    expect(mocks.loadURL).toHaveBeenCalledWith('https://example.com')
    expect(mocks.webContents.executeJavaScript).toHaveBeenCalledWith('document.documentElement.outerHTML')
  })

  it('stops a page that exceeds the hard load timeout', async () => {
    mocks.loadURL.mockReturnValue(new Promise(() => {}))
    const service = new SearchService()
    const resultPromise = service.openUrlInSearchWindow('search-2', 'https://slow.example.com')
    const rejection = expect(resultPromise).rejects.toThrow(`timed out after ${SEARCH_PAGE_LOAD_TIMEOUT_MS}ms`)

    await vi.advanceTimersByTimeAsync(SEARCH_PAGE_LOAD_TIMEOUT_MS)

    await rejection
    expect(mocks.webContents.stop).toHaveBeenCalledOnce()
  })

  it('fetches an allowlisted structured search resource through Electron net', async () => {
    mocks.netFetch.mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    const service = new SearchService()

    await expect(service.fetchSearchResource('https://api.open-meteo.com/v1/forecast')).resolves.toMatchObject({
      body: '{"ok":true}',
      contentType: 'application/json',
      ok: true,
      status: 200
    })
    expect(mocks.netFetch).toHaveBeenCalledOnce()
  })

  it('rejects non-HTTPS and non-allowlisted structured search resources', async () => {
    const service = new SearchService()

    expect(isAllowedSearchResourceUrl('http://api.open-meteo.com/v1/forecast')).toBe(false)
    expect(isAllowedSearchResourceUrl('https://example.com/private')).toBe(false)
    await expect(service.fetchSearchResource('https://example.com/private')).rejects.toThrow('not allowed')
    expect(mocks.netFetch).not.toHaveBeenCalled()
  })
})
