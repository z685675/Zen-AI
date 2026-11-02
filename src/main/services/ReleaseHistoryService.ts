import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { APP_UPDATE_FEED_URL } from '@shared/config/constant'
import {
  isStableReleaseVersion,
  mergeReleaseHistory,
  readReleaseHistory,
  RELEASE_HISTORY_MAX_BYTES,
  type ReleaseHistoryData,
  type ReleaseHistorySnapshot
} from '@shared/releaseHistory'
import { app, net } from 'electron'

import bundledArchive from '../../../resources/release-history.json'

const logger = loggerService.withContext('ReleaseHistoryService')
const generated = Object.values(
  import.meta.glob('../../../resources/release-history.generated.json', { eager: true, import: 'default' })
)[0]
const localNotes = import.meta.glob<string>('../../../release-notes/v*.md', {
  eager: true,
  query: '?raw',
  import: 'default'
})
const bundledHistory = readReleaseHistory(generated) ?? readReleaseHistory(bundledArchive)!
const REFRESH_INTERVAL_MS = 10 * 60 * 1000

export class ReleaseHistoryService {
  private archive: ReleaseHistoryData | undefined
  private loaded: Promise<void> | undefined
  private refreshPromise: Promise<ReleaseHistorySnapshot> | undefined
  private refreshedAt: string | null = null
  private lastAttemptAt = 0
  private refreshFailed = false

  constructor(
    private readonly currentVersion = app.getVersion(),
    private readonly builtin = bundledHistory,
    private readonly cachePath = path.join(app.getPath('userData'), 'Data', 'release-history', 'history.json'),
    private readonly currentNotes = localNotes[`../../../release-notes/v${currentVersion}.md`] ?? ''
  ) {}

  async getSnapshot(refreshFailed = this.refreshFailed): Promise<ReleaseHistorySnapshot> {
    this.loaded ??= this.loadCache()
    await this.loaded
    // The installed build may precede final publication. Its own notes are an
    // offline fallback; published/cached final wording always wins over them.
    const installed =
      isStableReleaseVersion(this.currentVersion) && this.currentNotes.trim()
        ? [{ version: this.currentVersion, notes: this.currentNotes, releaseDate: null }]
        : []
    return {
      currentVersion: this.currentVersion,
      entries: mergeReleaseHistory(installed, this.builtin.entries, this.archive?.entries ?? []),
      refreshedAt: this.refreshedAt,
      refreshFailed
    }
  }

  async refresh(force = false): Promise<ReleaseHistorySnapshot> {
    if (this.refreshPromise) return this.refreshPromise
    if (!force && this.lastAttemptAt > 0 && Date.now() - this.lastAttemptAt < REFRESH_INTERVAL_MS)
      return this.getSnapshot()
    this.lastAttemptAt = Date.now()
    this.refreshPromise = this.fetchHistory().finally(() => {
      this.refreshPromise = undefined
    })
    return this.refreshPromise
  }

  private async loadCache() {
    try {
      if ((await stat(this.cachePath)).size > RELEASE_HISTORY_MAX_BYTES)
        throw new Error('Release history cache exceeds limit')
      const cache = readReleaseHistory(JSON.parse(await readFile(this.cachePath, 'utf8')))
      if (!cache) throw new Error('Invalid release history cache')
      this.archive = cache
      this.refreshedAt = cache.updatedAt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        logger.warn('Using bundled release history', error as Error)
    }
  }

  private async fetchHistory(): Promise<ReleaseHistorySnapshot> {
    await this.getSnapshot()
    let temporary: string | undefined
    try {
      const base = APP_UPDATE_FEED_URL.trim() || 'https://download.925636.xyz/zen-ai/'
      const response = await net.fetch(new URL('release-history.json', base.endsWith('/') ? base : `${base}/`).href, {
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) throw new Error(`Release history HTTP ${response.status}`)
      if (Number(response.headers.get('content-length')) > RELEASE_HISTORY_MAX_BYTES)
        throw new Error('Release history exceeds limit')
      if (!response.body) throw new Error('Empty release history response')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > RELEASE_HISTORY_MAX_BYTES) throw new Error('Release history exceeds limit')
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      const incoming = readReleaseHistory(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (!incoming || !incoming.entries.length) throw new Error('Invalid published release history')
      const next: ReleaseHistoryData = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        entries: mergeReleaseHistory(this.archive?.entries ?? [], incoming.entries)
      }
      await mkdir(path.dirname(this.cachePath), { recursive: true })
      temporary = `${this.cachePath}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(next), 'utf8')
      await rename(temporary, this.cachePath)
      this.archive = next
      this.refreshedAt = next.updatedAt
      this.refreshFailed = false
      return this.getSnapshot()
    } catch (error) {
      logger.warn('Could not refresh release history; preserving local records', error as Error)
      this.refreshFailed = true
      return this.getSnapshot(true)
    } finally {
      if (temporary) await unlink(temporary).catch(() => undefined)
    }
  }
}

let instance: ReleaseHistoryService | undefined
const getService = () => (instance ??= new ReleaseHistoryService())
export const releaseHistoryService = {
  getSnapshot: () => getService().getSnapshot(),
  refresh: (force = false) => getService().refresh(force)
}
