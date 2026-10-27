import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loggerService } from '@logger'

export type StudioAssets = {
  find: (bytes: Buffer) => string | undefined
  remember: (bytes: Buffer, id: string) => void
  forget: (bytes: Buffer) => void
  alias: (original: Buffer, normalized: Buffer) => void
}
type Entry = { scope: string; digest: string; id: string; savedAt: number }
const logger = loggerService.withContext('ImageCanvas')
const maxEntries = 1000
const maxAge = 30 * 24 * 3600000
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

// An optional acceleration index. It contains hashes and remote IDs, never keys
// or image content. Every hit is checked against the server before job submission.
export class StudioAssetCache {
  private entries: Entry[] = []
  private readonly path: string

  constructor(directory: string) {
    this.path = join(directory, 'studio-assets.json')
    try {
      if (!existsSync(this.path)) return
      if (statSync(this.path).size > 512 * 1024) throw new Error('invalid_cache')
      const entries: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!Array.isArray(entries)) throw new Error('invalid_cache')
      this.entries = entries
        .filter(
          (entry): entry is Entry =>
            entry &&
            typeof entry.scope === 'string' &&
            /^[a-f0-9]{64}$/.test(entry.scope) &&
            typeof entry.digest === 'string' &&
            /^[a-f0-9]{64}$/.test(entry.digest) &&
            typeof entry.id === 'string' &&
            /^[a-f0-9-]{32,64}$/.test(entry.id) &&
            Number.isSafeInteger(entry.savedAt) &&
            entry.savedAt <= Date.now() &&
            entry.savedAt > Date.now() - maxAge
        )
        .slice(-maxEntries)
    } catch {
      logger.warn('Image studio asset cache ignored', { code: 'invalid_asset_cache' })
    }
  }

  forScope(scope: string): StudioAssets {
    const find = (bytes: Buffer) => {
      const hash = digest(bytes)
      return this.entries.find(
        (entry) => entry.scope === scope && entry.digest === hash && entry.savedAt > Date.now() - maxAge
      )?.id
    }
    const forget = (bytes: Buffer) => {
      const hash = digest(bytes)
      this.entries = this.entries.filter((entry) => entry.scope !== scope || entry.digest !== hash)
      this.persist()
    }
    const remember = (bytes: Buffer, id: string) => {
      if (!/^[a-f0-9-]{32,64}$/.test(id)) return
      const hash = digest(bytes)
      this.entries = this.entries.filter(
        (entry) => entry.savedAt > Date.now() - maxAge && (entry.scope !== scope || entry.digest !== hash)
      )
      this.entries.push({ scope, digest: hash, id, savedAt: Date.now() })
      this.entries = this.entries.slice(-maxEntries)
      this.persist()
    }
    return {
      find,
      forget,
      remember,
      // TaskStore uses this only for the equivalent PNG it creates from a result.
      alias: (original, normalized) => {
        const id = find(original)
        if (id) remember(normalized, id)
      }
    }
  }

  private persist() {
    try {
      writeFileSync(`${this.path}.tmp`, JSON.stringify(this.entries), { mode: 0o600 })
      renameSync(`${this.path}.tmp`, this.path)
    } catch {
      // A cache failure must never change task/billing recovery semantics.
      logger.warn('Image studio asset cache save skipped', { code: 'asset_cache_write_failed' })
    }
  }
}
