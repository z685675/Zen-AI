import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loggerService } from '@logger'

export type DownloadCheckpoint = { bytes: Buffer; etag: string; total: number; digest?: string }
export type DownloadCheckpoints = {
  load: (id: string) => DownloadCheckpoint | undefined
  save: (id: string, value: DownloadCheckpoint) => void
  remove: (id: string) => void
}
export const maxDownloadBytes = 20 * 1024 * 1024
export const strongImageEtag = (value: string | null): value is string =>
  !!value && /^"[\x21\x23-\x7e]{1,160}"$/.test(value)
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const logger = loggerService.withContext('ImageCanvas')
const maxAge = 7 * 24 * 3600000

// Optional recovery data, scoped by the existing provider/credential fingerprint.
// No API credentials or remote URLs are written to disk. Cache failures must not
// affect a generated task, and a damaged checkpoint is always discarded.
export class StudioDownloadCache {
  private readonly directory: string

  constructor(directory: string) {
    this.directory = join(directory, 'downloads')
  }

  forScope(scope: string): DownloadCheckpoints {
    const key = (id: string) => {
      if (!/^[a-f0-9]{64}$/.test(scope) || !/^[a-f0-9-]{32,64}$/.test(id)) throw new Error('invalid_download_cache_key')
      return hash(`${scope}\0${id}`)
    }
    const remove = (id: string) => this.remove(key(id))
    return {
      remove,
      load: (id) => {
        const name = key(id)
        try {
          const path = join(this.directory, `${name}.json`)
          if (statSync(path).size > 2048) throw new Error('invalid_checkpoint')
          const value = JSON.parse(readFileSync(path, 'utf8'))
          if (
            !strongImageEtag(value.etag) ||
            !Number.isSafeInteger(value.total) ||
            value.total < 1 ||
            value.total > maxDownloadBytes ||
            !Number.isSafeInteger(value.savedAt) ||
            value.savedAt > Date.now() ||
            value.savedAt < Date.now() - maxAge ||
            (value.digest !== undefined && !/^[a-f0-9]{64}$/.test(value.digest))
          )
            throw new Error('invalid_checkpoint')
          const part = join(this.directory, `${name}.part`)
          if (statSync(part).size > value.total) throw new Error('invalid_checkpoint')
          const bytes = readFileSync(part)
          if (!bytes.length || hash(bytes) !== value.partialHash) throw new Error('invalid_checkpoint')
          return { bytes, etag: value.etag, total: value.total, digest: value.digest }
        } catch {
          this.remove(name)
          return undefined
        }
      },
      save: (id, value) => {
        if (
          !strongImageEtag(value.etag) ||
          !value.bytes.length ||
          value.bytes.length > value.total ||
          !Number.isSafeInteger(value.total) ||
          value.total > maxDownloadBytes
        )
          return
        const name = key(id)
        try {
          mkdirSync(this.directory, { recursive: true, mode: 0o700 })
          const path = join(this.directory, name)
          writeFileSync(`${path}.part.tmp`, value.bytes, { mode: 0o600 })
          renameSync(`${path}.part.tmp`, `${path}.part`)
          writeFileSync(
            `${path}.json.tmp`,
            JSON.stringify({
              etag: value.etag,
              total: value.total,
              digest: value.digest,
              savedAt: Date.now(),
              partialHash: hash(value.bytes)
            }),
            { mode: 0o600 }
          )
          renameSync(`${path}.json.tmp`, `${path}.json`)
          const records = readdirSync(this.directory)
            .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
            .map((file) => ({ name: file.slice(0, 64), time: statSync(join(this.directory, file)).mtimeMs }))
            .sort((a, b) => b.time - a.time)
          for (const [index, entry] of records.entries())
            if (index >= 32 || entry.time < Date.now() - maxAge) this.remove(entry.name)
        } catch {
          logger.warn('Image download checkpoint save skipped', { code: 'download_checkpoint_write_failed' })
        }
      }
    }
  }

  private remove(name: string) {
    for (const extension of ['json', 'part', 'json.tmp', 'part.tmp']) {
      try {
        unlinkSync(join(this.directory, `${name}.${extension}`))
      } catch {
        // Missing or locked optional cache files can be cleaned on a later pass.
      }
    }
  }
}
