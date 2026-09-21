import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { app, type DownloadItem, type Session, type WebContents } from 'electron'

import { logger } from './types'

export type BrowserDownloadState = 'in_progress' | 'completed' | 'interrupted' | 'cancelled'

export interface BrowserDownloadInfo {
  id: string
  tabId: string
  privateMode: boolean
  filename: string
  path: string
  url: string
  mimeType?: string
  state: BrowserDownloadState
  receivedBytes: number
  totalBytes: number
  startedAt: number
  updatedAt: number
  completedAt?: number
  error?: string
}

type TabLookupResult = { tabId: string; privateMode: boolean }
type DownloadWaiter = {
  matches: (download: BrowserDownloadInfo) => boolean
  resolve: (download: BrowserDownloadInfo) => void
  reject: (error: Error) => void
  timeoutHandle?: ReturnType<typeof setTimeout>
}

const DOWNLOAD_DIRECTORY_NAME = 'Zen AI Browser Downloads'
const RECENT_DOWNLOAD_GRACE_MS = 5000
const MAX_HISTORY = 50

function sanitizeFilename(filename: string): string {
  const normalized = filename
    .replace(/[<>:"/\\|?*]/g, '_')
    .split('')
    .map((character) => (character.charCodeAt(0) <= 0x1f ? '_' : character))
    .join('')
    .replace(/[. ]+$/g, '')
    .trim()
  return normalized || 'download'
}

function uniqueDownloadPath(directory: string, filename: string, id: string): string {
  const safeName = sanitizeFilename(filename)
  const extension = path.extname(safeName)
  const stem = extension ? safeName.slice(0, -extension.length) : safeName
  const firstCandidate = path.join(directory, safeName)
  if (!fs.existsSync(firstCandidate)) return firstCandidate
  return path.join(directory, `${stem}-${id.slice(0, 8)}${extension}`)
}

function safeNumber(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Owns browser downloads for one MCP browser controller.
 *
 * Electron's `will-download` event belongs to the Session, not the BrowserView.
 * The tab lookup keeps multiple Zen AI agent sessions from claiming each
 * other's downloads when they share the normal persistent browser partition.
 */
export class BrowserDownloadManager {
  private readonly downloads = new Map<string, BrowserDownloadInfo>()
  private readonly waiters = new Set<DownloadWaiter>()
  private readonly sessionHandlers = new Map<
    Session,
    (event: Electron.Event, item: DownloadItem, webContents: WebContents) => void
  >()

  constructor(private readonly resolveTab: (webContentsId: number) => TabLookupResult | undefined) {}

  attachSession(session: Session): void {
    if (this.sessionHandlers.has(session)) return

    const handler = (event: Electron.Event, item: DownloadItem, webContents: WebContents) => {
      const tab = this.resolveTab(webContents.id)
      if (!tab) return
      this.handleWillDownload(event, item, tab)
    }

    session.on('will-download', handler)
    this.sessionHandlers.set(session, handler)
  }

  detachAll(): void {
    for (const [session, handler] of this.sessionHandlers) {
      session.removeListener('will-download', handler)
    }
    this.sessionHandlers.clear()

    for (const waiter of this.waiters) {
      if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle)
      waiter.reject(new Error('Browser download manager was closed'))
    }
    this.waiters.clear()
  }

  list(options?: { privateMode?: boolean; tabId?: string }): BrowserDownloadInfo[] {
    return [...this.downloads.values()]
      .filter((download) => options?.privateMode === undefined || download.privateMode === options.privateMode)
      .filter((download) => !options?.tabId || download.tabId === options.tabId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((download) => ({ ...download }))
  }

  get(downloadId: string): BrowserDownloadInfo | undefined {
    const download = this.downloads.get(downloadId)
    return download ? { ...download } : undefined
  }

  async waitForDownload(
    options: { downloadId?: string; privateMode?: boolean; tabId?: string; timeoutMs?: number } = {}
  ): Promise<BrowserDownloadInfo> {
    const existing = this.findExisting(options)
    if (existing) return { ...existing }

    const timeoutMs = Math.max(1000, Math.min(options.timeoutMs ?? 120_000, 15 * 60_000))

    return await new Promise<BrowserDownloadInfo>((resolve, reject) => {
      const waiter: DownloadWaiter = {
        matches: (download) => this.matches(download, options),
        resolve: (download) => {
          if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle)
          this.waiters.delete(waiter)
          resolve({ ...download })
        },
        reject: (error) => {
          if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle)
          this.waiters.delete(waiter)
          reject(error)
        }
      }

      waiter.timeoutHandle = setTimeout(() => {
        waiter.reject(new Error(`Timed out waiting for browser download after ${Math.round(timeoutMs / 1000)} seconds`))
      }, timeoutMs)

      this.waiters.add(waiter)
    })
  }

  private getDownloadDirectory(): string {
    const directory = path.join(app.getPath('downloads'), DOWNLOAD_DIRECTORY_NAME)
    fs.mkdirSync(directory, { recursive: true })
    return directory
  }

  private handleWillDownload(_event: Electron.Event, item: DownloadItem, tab: TabLookupResult): void {
    const id = randomUUID()
    const filename = item.getFilename() || 'download'
    const downloadPath = uniqueDownloadPath(this.getDownloadDirectory(), filename, id)
    const now = Date.now()

    item.setSavePath(downloadPath)

    const download: BrowserDownloadInfo = {
      id,
      tabId: tab.tabId,
      privateMode: tab.privateMode,
      filename: path.basename(downloadPath),
      path: downloadPath,
      url: item.getURL(),
      mimeType: item.getMimeType() || undefined,
      state: 'in_progress',
      receivedBytes: safeNumber(item.getReceivedBytes()),
      totalBytes: safeNumber(item.getTotalBytes()),
      startedAt: now,
      updatedAt: now
    }

    this.downloads.set(id, download)
    this.trimHistory()
    logger.info('Browser download started', {
      downloadId: id,
      tabId: tab.tabId,
      filename: download.filename,
      path: download.path,
      privateMode: tab.privateMode
    })

    item.on('updated', () => {
      const current = this.downloads.get(id)
      if (!current) return
      current.receivedBytes = safeNumber(item.getReceivedBytes())
      current.totalBytes = safeNumber(item.getTotalBytes())
      current.updatedAt = Date.now()
    })

    item.once('done', (_event, state) => {
      const current = this.downloads.get(id)
      if (!current) return

      current.receivedBytes = safeNumber(item.getReceivedBytes())
      current.totalBytes = safeNumber(item.getTotalBytes())
      current.updatedAt = Date.now()
      current.completedAt = current.updatedAt
      current.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      if (current.state === 'completed') {
        try {
          const stat = fs.statSync(current.path)
          if (!stat.isFile()) {
            current.state = 'interrupted'
            current.error = 'Downloaded path is not a file'
          }
        } catch (error) {
          current.state = 'interrupted'
          current.error = error instanceof Error ? error.message : String(error)
        }
      }
      if (current.state !== 'completed' && !current.error) current.error = `Download ${current.state}`

      logger.info('Browser download finished', {
        downloadId: id,
        state: current.state,
        path: current.path,
        receivedBytes: current.receivedBytes,
        totalBytes: current.totalBytes
      })
      this.notifyWaiters(current)
    })
  }

  private findExisting(options: {
    downloadId?: string
    privateMode?: boolean
    tabId?: string
  }): BrowserDownloadInfo | undefined {
    if (options.downloadId) {
      const download = this.downloads.get(options.downloadId)
      if (download && this.matches(download, options) && download.state !== 'in_progress') return download
      if (download && this.matches(download, options)) return undefined
      return undefined
    }

    const matching = this.list(options)
    const inProgress = matching.find((download) => download.state === 'in_progress')
    if (inProgress) return undefined

    const latest = matching[0]
    if (latest?.completedAt && Date.now() - latest.completedAt <= RECENT_DOWNLOAD_GRACE_MS) return latest
    return undefined
  }

  private matches(
    download: BrowserDownloadInfo,
    options: { downloadId?: string; privateMode?: boolean; tabId?: string }
  ): boolean {
    return (
      (!options.downloadId || download.id === options.downloadId) &&
      (options.privateMode === undefined || download.privateMode === options.privateMode) &&
      (!options.tabId || download.tabId === options.tabId)
    )
  }

  private notifyWaiters(download: BrowserDownloadInfo): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.matches(download)) waiter.resolve(download)
    }
  }

  private trimHistory(): void {
    if (this.downloads.size <= MAX_HISTORY) return
    const ids = [...this.downloads.values()]
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(0, Math.max(0, this.downloads.size - MAX_HISTORY))
      .map((download) => download.id)
    for (const id of ids) this.downloads.delete(id)
  }
}
