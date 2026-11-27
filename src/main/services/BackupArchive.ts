import { createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32 } from 'node:zlib'

import StreamZip from 'node-stream-zip'

const GiB = 1024 ** 3
export const MAX_BACKUP_ARCHIVE_BYTES = 16 * GiB
const BACKUP_LIMITS = { archiveBytes: MAX_BACKUP_ARCHIVE_BYTES, extractedBytes: 64 * GiB, entries: 200_000 }

export function limitBackupBytes(limit: number, expectedCrc?: number): Transform {
  let bytes = 0
  let crc = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length
      if (bytes > limit) return done(new Error('Backup stream exceeds the allowed size'))
      if (expectedCrc !== undefined) crc = crc32(chunk, crc)
      done(null, chunk)
    },
    flush(done) {
      if (expectedCrc !== undefined && (bytes !== limit || crc !== expectedCrc)) {
        done(new Error('Backup entry failed its size or checksum check'))
      } else done()
    }
  })
}

export function validateWebDavBackupName(name: string): void {
  if (
    typeof name !== 'string' ||
    !name ||
    name === '.' ||
    name === '..' ||
    /[\\/:]/.test(name) ||
    hasControlCharacters(name)
  )
    throw new Error('Invalid WebDAV backup file name')
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((char) => char.charCodeAt(0) < 32)
}

function entryPath(entry: StreamZip.ZipEntry, root: string): string {
  const relative = entry.isDirectory ? entry.name.slice(0, -1) : entry.name
  const segments = relative.split('/')
  if (
    Buffer.byteLength(relative) > 4096 ||
    hasControlCharacters(relative) ||
    segments.some((part) => !part || part === '..' || part === '.' || /[\\:]/.test(part))
  )
    throw new Error('Unsafe path in backup archive')
  if (
    process.platform === 'win32' &&
    segments.some((part) => /[. ]$|[<>"|?*]|^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])(?:\.|$)/i.test(part))
  )
    throw new Error('Windows cannot safely restore this backup path')

  const mode = (entry.attr >>> 16) & 0o170000
  if (entry.encrypted || (mode !== 0 && mode !== (entry.isDirectory ? 0o040000 : 0o100000)))
    throw new Error('Backup archive contains an unsupported entry type')

  return path.resolve(root, ...segments)
}

export async function extractBackupArchive(file: string, destination: string, limits = BACKUP_LIMITS): Promise<void> {
  const source = await stat(file)
  if (!source.isFile() || source.size > limits.archiveBytes)
    throw new Error('Invalid backup archive or compressed size exceeds the limit')

  const zip = new StreamZip({ file, storeEntries: false })
  try {
    const entries: Array<{ entry: StreamZip.ZipEntry; target: string }> = []
    const targets = new Set<string>()
    let bytes = 0
    let nameBytes = 0
    // Validate the central directory as it is read so malformed or oversized
    // archives never fill an unbounded entry map or leave partial output.
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject)
      zip.on('ready', resolve)
      zip.on('entry', (entry) => {
        if (entries.length >= limits.entries) throw new Error('Backup archive has too many entries')
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || (entry.isDirectory && entry.size !== 0))
          throw new Error('Backup archive has an invalid entry size')
        bytes += entry.size
        nameBytes += Buffer.byteLength(entry.name)
        if (bytes > limits.extractedBytes || nameBytes > 32 * 1024 * 1024)
          throw new Error('Backup archive expands beyond the allowed size')
        const target = entryPath(entry, destination)
        const key = process.platform === 'win32' ? target.toLowerCase() : target
        if (targets.has(key)) throw new Error('Backup archive contains duplicate paths')
        targets.add(key)
        entries.push({ entry, target })
      })
    })
    if (!entries.length) throw new Error('Backup archive is empty')

    for (const { entry, target } of entries) {
      if (entry.isDirectory) {
        await mkdir(target, { recursive: true })
        continue
      }
      await mkdir(path.dirname(target), { recursive: true })
      // The ZIP reader can update metadata from the local header. Enforce the
      // central directory's already-validated size and CRC on emitted bytes.
      const { size, crc } = entry
      const source = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
        zip.stream(entry, (error, stream) => {
          if (error || !stream) reject(error ?? new Error('Cannot read backup entry'))
          else resolve(stream)
        })
      })
      await pipeline(source, limitBackupBytes(size, crc), createWriteStream(target, { flags: 'wx', mode: 0o600 }))
    }
  } finally {
    await new Promise<void>((resolve, reject) => zip.close((error) => (error ? reject(error) : resolve())))
  }
}
