import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  assertSafeOutput,
  assistantFileHash,
  restoreAssistantFile,
  snapshotAssistantFile,
  undoAssistantFileCreation
} from '@main/mcpServers/assistantFileSafety'
import type {
  AssistantFileChange,
  AssistantFilePreview,
  AssistantFileRestoreResult
} from '@shared/agents/assistantFileChanges'

const RECORD_LIMIT = 200
const TURN_LIMIT = 64
const PREVIEW_LIMIT = 48 * 1024
const documentExtensions = new Set(['.pdf', '.docx', '.xlsx', '.pptx'])
const recordId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

type RecordData = Omit<AssistantFileChange, 'canRestore'> & {
  canonicalPath: string
  before: string | null
  after: string | null
}

function publicChange(record: RecordData): AssistantFileChange {
  return {
    id: record.id,
    turn: record.turn,
    path: record.path,
    kind: record.kind,
    changedAt: record.changedAt,
    canRestore: !record.restoredAt,
    restoredAt: record.restoredAt
  }
}

async function canonicalFile(file: string, roots: string[]) {
  await assertSafeOutput(file, roots)
  let parent = path.dirname(file)
  for (;;) {
    try {
      return path.join(await fs.realpath(parent), path.relative(parent, file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path.dirname(parent)) throw error
      parent = path.dirname(parent)
    }
  }
}

function isUserFile(file: string) {
  return !file.split(/[\\/]/).some((part) => ['.agents', '.git', '.zen-backups'].includes(part.toLowerCase()))
}

async function previewText(file: string, size: number) {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(size, PREVIEW_LIMIT))
    const { bytesRead } = await handle.read(buffer)
    const bytes = buffer.subarray(0, bytesRead)
    const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe
    if (!utf16 && bytes.includes(0)) return undefined
    return new TextDecoder(utf16 ? 'utf-16le' : 'utf-8', { fatal: true }).decode(bytes, {
      stream: bytesRead < size
    })
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}

export class AssistantFileChangeStore {
  private readonly directory: string

  constructor(root: string, sessionId: string) {
    this.directory = path.join(root, createHash('sha256').update(sessionId).digest('hex'))
  }

  private backup(id: string) {
    return path.join(this.directory, `${id}.bak`)
  }

  private manifest(id: string) {
    return path.join(this.directory, `${id}.json`)
  }

  async stage(file: string, backup?: string, signal?: AbortSignal) {
    const id = randomUUID()
    const before = backup ?? file
    if (
      await fs.lstat(before).then(
        () => false,
        (error: NodeJS.ErrnoException) => {
          if (!backup && error.code === 'ENOENT') return true
          throw error
        }
      )
    )
      return { id, before: null }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const hash = await snapshotAssistantFile(before, this.backup(id), signal)
      return { id, before: hash }
    } catch (error) {
      await this.discard(id)
      throw error
    }
  }

  async discard(id: string) {
    await fs.unlink(this.backup(id)).catch(() => undefined)
  }

  async remove(id: string) {
    await fs.unlink(this.manifest(id))
    await this.discard(id)
  }

  async write(record: RecordData) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const stage = path.join(this.directory, `${record.id}.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(stage, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
      await fs.rename(stage, this.manifest(record.id))
    } finally {
      await fs.unlink(stage).catch(() => undefined)
    }
  }

  private async read(id: string): Promise<RecordData | undefined> {
    if (!recordId.test(id)) return
    return fs
      .readFile(this.manifest(id), 'utf8')
      .then(JSON.parse)
      .catch(() => undefined)
  }

  async list() {
    const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => [])
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => this.read(entry.name.slice(0, -5)))
    )
    return records
      .filter((record): record is RecordData => Boolean(record))
      .sort((a, b) => b.changedAt - a.changedAt)
      .slice(0, RECORD_LIMIT)
      .map(publicChange)
  }

  async preview(id: string, roots: string[]): Promise<AssistantFilePreview | undefined> {
    const record = await this.read(id)
    if (!record) return
    const file = record.path
    const beforePath = this.backup(id)
    const canonical = await canonicalFile(file, roots).catch(() => undefined)
    if (!canonical || canonical !== record.canonicalPath || !isUserFile(canonical)) return
    const currentHash = await assistantFileHash(file)
    const beforeHash = record.before === null ? null : await assistantFileHash(beforePath)
    if (beforeHash !== record.before) return
    const beforeBytes = beforeHash === null ? null : (await fs.lstat(beforePath)).size
    const currentBytes = currentHash === null ? null : (await fs.lstat(file)).size
    const summary = { beforeBytes, currentBytes, changedSince: currentHash !== record.after }
    const ext = path.extname(file).toLowerCase()
    let before: string | undefined
    let current: string | undefined
    let partial = false
    let format: AssistantFilePreview['format'] = 'text'
    if (documentExtensions.has(ext)) {
      format = 'document'
      const { readAssistantDocument } = await import('@main/mcpServers/assistantReadDocument')
      const read = async (source: string) => {
        // The parser uses the extension. Open a verified private copy of the
        // backup, or a verified copy of the live file, and remove it after use.
        const temporary = path.join(this.directory, `preview-${randomUUID()}${ext}`)
        try {
          const expected = source === file ? currentHash : beforeHash
          if ((await snapshotAssistantFile(source, temporary)) !== expected) throw new Error('File changed')
          const result = await readAssistantDocument(
            { file_path: temporary, max_chars: 18000, max_sections: 20, max_pages: 8 },
            () => temporary,
            AbortSignal.timeout(8000)
          )
          partial ||= Boolean(result.next_cursor)
          return result.chunks.map((chunk) => chunk.text).join('\n')
        } finally {
          await fs.unlink(temporary).catch(() => undefined)
        }
      }
      try {
        before = beforeBytes === null ? '' : await read(beforePath)
        current = currentBytes === null ? '' : await read(file)
      } catch {
        format = 'metadata'
      }
    } else {
      before = beforeBytes === null ? '' : await previewText(beforePath, beforeBytes)
      current = currentBytes === null ? '' : await previewText(file, currentBytes)
      partial = (beforeBytes ?? 0) > PREVIEW_LIMIT || (currentBytes ?? 0) > PREVIEW_LIMIT
      if (before === undefined || current === undefined) format = 'metadata'
    }
    if (
      (await canonicalFile(file, roots)) !== canonical ||
      (await assistantFileHash(file)) !== currentHash ||
      (beforeHash !== null && (await assistantFileHash(beforePath)) !== beforeHash)
    )
      return undefined
    return format === 'metadata'
      ? { ...summary, format, partial: false }
      : { ...summary, format, before, current, partial }
  }

  async restore(
    id: string,
    roots: string[],
    trash: (file: string) => Promise<void>
  ): Promise<AssistantFileRestoreResult> {
    const record = await this.read(id)
    if (!record || record.restoredAt) return 'unavailable'
    const canonical = await canonicalFile(record.path, roots).catch(() => undefined)
    if (!canonical || canonical !== record.canonicalPath || !isUserFile(canonical)) return 'unavailable'
    const restored =
      record.before === null
        ? record.after !== null && (await undoAssistantFileCreation(record.path, roots, canonical, record.after, trash))
        : await restoreAssistantFile(record.path, this.backup(id), roots, {
            before: record.before,
            after: record.after,
            canonicalPath: canonical
          })
    if (!restored) return 'conflict'
    await this.write({ ...record, restoredAt: Date.now() }).catch(() => undefined)
    return 'restored'
  }
}

export class AssistantFileChangeTurn {
  private count = 0
  private closed = false
  private readonly recorded = new Map<string, RecordData>()
  private readonly pending = new Map<
    string,
    Array<{ id: string; before: string | null; path: string; canonicalPath: string }>
  >()
  private readonly preparedBackups = new Map<
    string,
    NonNullable<Awaited<ReturnType<AssistantFileChangeTurn['capture']>>>
  >()

  constructor(
    private store: AssistantFileChangeStore,
    private turn: string,
    private roots: string[],
    private signal: AbortSignal
  ) {}

  private async capture(file: string, backup?: string, created = false) {
    if (this.closed || this.count >= TURN_LIMIT || !path.isAbsolute(file) || !isUserFile(file)) return
    this.count++
    const canonicalPath = await canonicalFile(file, this.roots)
    if (!isUserFile(canonicalPath)) return
    const entry = {
      path: file,
      canonicalPath,
      ...(created ? { id: randomUUID(), before: null } : await this.store.stage(file, backup, this.signal))
    }
    if (!this.closed) return entry
    await this.store.discard(entry.id)
    return undefined
  }

  private async record(entry: { id: string; before: string | null; path: string; canonicalPath: string }) {
    let written = false
    try {
      if ((await canonicalFile(entry.path, this.roots)) !== entry.canonicalPath) return
      const after = await assistantFileHash(entry.path)
      if (entry.before === after) return
      const previous = this.recorded.get(entry.canonicalPath)
      const prior = previous && previous.after === entry.before ? previous : undefined
      if (prior && prior.before === after) {
        await this.store.remove(prior.id)
        this.recorded.delete(entry.canonicalPath)
        return
      }
      const before = prior ? prior.before : entry.before
      const record: RecordData = {
        ...(prior ?? entry),
        turn: this.turn,
        kind: before === null ? 'created' : after === null ? 'deleted' : 'modified',
        changedAt: Date.now(),
        after
      }
      await this.store.write(record)
      this.recorded.set(entry.canonicalPath, record)
      written = !prior
    } finally {
      if (!written) await this.store.discard(entry.id)
    }
  }

  async productWrite(file: string, backup?: string) {
    const entry = await this.capture(file, backup, !backup)
    if (entry) await this.record(entry)
  }

  async backedUp(file: string, backup: string) {
    if (this.preparedBackups.has(file)) return
    const entry = await this.capture(file, backup)
    if (entry) this.preparedBackups.set(file, entry)
  }

  async presented(files: string[]) {
    for (const file of files) {
      const entry = this.preparedBackups.get(file)
      if (!entry) continue
      this.preparedBackups.delete(file)
      await this.record(entry).catch(() => undefined)
    }
  }

  async begin(toolCall: string, files: string[]) {
    if (this.pending.has(toolCall) || this.pending.size >= TURN_LIMIT) return
    const entries: NonNullable<Awaited<ReturnType<AssistantFileChangeTurn['capture']>>>[] = []
    this.pending.set(toolCall, entries)
    for (const file of new Set(files)) {
      const entry = await this.capture(file).catch(() => undefined)
      if (entry) entries.push(entry)
    }
  }

  async finish(toolCall: string) {
    const entries = this.pending.get(toolCall) ?? []
    this.pending.delete(toolCall)
    await Promise.all(entries.map((entry) => this.record(entry).catch(() => undefined)))
  }

  async close() {
    this.closed = true
    const entries = [...this.pending.values()].flat().concat([...this.preparedBackups.values()])
    this.pending.clear()
    this.preparedBackups.clear()
    await Promise.all(entries.map((entry) => this.store.discard(entry.id)))
  }
}
