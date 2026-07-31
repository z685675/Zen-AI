import { is } from '@electron-toolkit/utils'
import { loggerService } from '@logger'
import { BrowserWindow, net } from 'electron'

const logger = loggerService.withContext('SearchService')

export const SEARCH_PAGE_LOAD_TIMEOUT_MS = 7000
export const SEARCH_PAGE_EXTRACT_TIMEOUT_MS = 3000
export const SEARCH_RESOURCE_TIMEOUT_MS = 18000
export const SEARCH_RESOURCE_MAX_LENGTH = 1_500_000
const SEARCH_PAGE_SETTLE_DELAY_MS = 350

const SEARCH_RESOURCE_HOSTS = new Set([
  '60s.viki.moe',
  'api.frankfurter.dev',
  'api.open-meteo.com',
  'feed.mix.sina.com.cn',
  'geocoding-api.open-meteo.com',
  'nodejs.org',
  'www.bing.com'
])

export type SearchResourceResponse = {
  body: string
  contentType: string
  finalUrl: string
  ok: boolean
  status: number
}

export function isAllowedSearchResourceUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && SEARCH_RESOURCE_HOSTS.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout?.()
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export class SearchService {
  private static instance: SearchService | null = null
  private searchWindows: Record<string, BrowserWindow> = {}
  public static getInstance(): SearchService {
    if (!SearchService.instance) {
      SearchService.instance = new SearchService()
    }
    return SearchService.instance
  }

  private async createNewSearchWindow(uid: string, show: boolean = false): Promise<BrowserWindow> {
    const newWindow = new BrowserWindow({
      width: 1280,
      height: 768,
      show,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        devTools: is.dev
      }
    })

    this.searchWindows[uid] = newWindow
    newWindow.on('closed', () => delete this.searchWindows[uid])

    newWindow.webContents.userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)  Safari/537.36'

    return newWindow
  }

  public async openSearchWindow(uid: string, show: boolean = false): Promise<void> {
    const existingWindow = this.searchWindows[uid]

    if (existingWindow) {
      show && existingWindow.show()
      return
    }

    await this.createNewSearchWindow(uid, show)
  }

  public async closeSearchWindow(uid: string): Promise<void> {
    const window = this.searchWindows[uid]
    if (window && !window.isDestroyed()) {
      window.close()
    }
    delete this.searchWindows[uid]
  }

  public async openUrlInSearchWindow(uid: string, url: string): Promise<any> {
    let window = this.searchWindows[uid]
    logger.debug(`Searching with URL: ${url}`)
    if (window) {
      if (window.isDestroyed()) {
        window = await this.createNewSearchWindow(uid)
      }
    } else {
      window = await this.createNewSearchWindow(uid)
    }

    await withTimeout(window.loadURL(url), SEARCH_PAGE_LOAD_TIMEOUT_MS, 'Search page load', () => {
      if (!window.isDestroyed()) window.webContents.stop()
    })

    // loadURL resolves after did-finish-load. A short settle delay is enough for
    // client-rendered search snippets without adding a second full load wait.
    await new Promise((resolve) => setTimeout(resolve, SEARCH_PAGE_SETTLE_DELAY_MS))

    if (window.isDestroyed()) {
      throw new Error('Search window was closed before content extraction')
    }

    return await withTimeout(
      window.webContents.executeJavaScript('document.documentElement.outerHTML'),
      SEARCH_PAGE_EXTRACT_TIMEOUT_MS,
      'Search page extraction'
    )
  }

  public async fetchSearchResource(url: string): Promise<SearchResourceResponse> {
    if (!isAllowedSearchResourceUrl(url)) {
      throw new Error('Search resource URL is not allowed')
    }

    const controller = new AbortController()
    return await withTimeout(
      (async () => {
        const response = await net.fetch(url, {
          headers: {
            Accept: 'application/json, application/xml, text/xml, text/plain;q=0.9, */*;q=0.8'
          },
          redirect: 'follow',
          signal: controller.signal
        })
        const finalUrl = response.url || url
        if (!isAllowedSearchResourceUrl(finalUrl)) {
          throw new Error('Search resource redirected to a non-allowlisted URL')
        }

        const contentLength = Number(response.headers.get('content-length') || 0)
        if (contentLength > SEARCH_RESOURCE_MAX_LENGTH) {
          throw new Error('Search resource response is too large')
        }

        const body = await response.text()
        if (body.length > SEARCH_RESOURCE_MAX_LENGTH) {
          throw new Error('Search resource response is too large')
        }

        return {
          body,
          contentType: response.headers.get('content-type') || '',
          finalUrl,
          ok: response.ok,
          status: response.status
        }
      })(),
      SEARCH_RESOURCE_TIMEOUT_MS,
      'Search resource request',
      () => controller.abort()
    )
  }
}

export const searchService = SearchService.getInstance()
