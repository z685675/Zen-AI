import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { StructuredFileSection } from '@types'

export const READ_DOCUMENT_TOOL: Tool = {
  name: 'read_document',
  description:
    'Read bounded extracted text from PDF, DOCX, XLSX, PPTX, or UTF-8/UTF-16 text/JSON. Prefer native read for normal source files. ' +
    'No raw PDF, images or base64 are returned. Follow next_cursor until null; partial results are NOT a whole-file read. ' +
    'PDF pages without text require ocr_file. Limits: 64 MiB documents, 256 MiB text, Office ZIP 4096 entries/8 MiB per parsed XML entry/24 MiB parsed XML total; binary media is skipped, ' +
    '4 million extracted characters, two concurrent reads. Split files that exceed parse limits.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Authorized absolute path, or relative to the first assistant allowed root.'
      },
      cursor: {
        type: 'string',
        description: 'Opaque next_cursor from this tool. Keep file_path; do not combine with start_page/start_section.'
      },
      start_page: { type: 'integer', minimum: 1, description: 'PDF only: first page (1-based), default 1.' },
      start_section: {
        type: 'integer',
        minimum: 1,
        description: 'Office only: first extracted section (1-based), default 1.'
      },
      max_pages: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
      max_sections: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
      max_chars: { type: 'integer', minimum: 256, maximum: 24000, default: 12000 }
    },
    required: ['file_path'],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
}

const MiB = 1024 * 1024
const secret = randomBytes(32)
const textExtensions = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
  '.ndjson',
  '.csv',
  '.tsv',
  '.log',
  '.xml',
  '.yaml',
  '.yml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.sh',
  '.sql',
  '.ini',
  '.toml',
  '.rst',
  '.tex'
])
const documentExtensions = new Set(['.pdf', '.docx', '.xlsx', '.pptx'])
let activeReads = 0

type Cursor = {
  v: 1
  source: string
  revision: string
  expires: number
  section: number
  offset: number
  byte: number
}

function integer(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number) {
  const value = args[name] === undefined ? fallback : args[name]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function sign(payload: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function encode(cursor: Cursor) {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
  return `${payload}.${sign(payload)}`
}

function decode(value: unknown): Cursor {
  if (typeof value !== 'string' || value.length > 2048)
    throw new Error('Invalid document cursor; restart without cursor')
  const [payload, signature, extra] = value.split('.')
  const expected = sign(payload ?? '')
  if (
    !signature ||
    extra !== undefined ||
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    throw new Error('Invalid document cursor; restart without cursor')
  }
  let cursor: Cursor
  try {
    cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Invalid document cursor; restart without cursor')
  }
  if (
    cursor.v !== 1 ||
    ![cursor.section, cursor.offset, cursor.byte, cursor.expires].every(Number.isSafeInteger) ||
    cursor.section < 0 ||
    cursor.offset < 0 ||
    cursor.byte < 0 ||
    typeof cursor.source !== 'string' ||
    typeof cursor.revision !== 'string'
  )
    throw new Error('Invalid document cursor; restart without cursor')
  if (cursor.expires < Date.now()) throw new Error('Stale document cursor (expired); restart without cursor')
  return cursor
}

function revision(stat: BigIntStats) {
  return createHash('sha256')
    .update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'))
    .digest('hex')
}

// Character offsets are UTF-16 code units. Never split a surrogate pair.
function boundedText(text: string, offset: number, budget: number) {
  let end = Math.min(text.length, offset + budget)
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  return text.slice(offset, end)
}

function boundedMetadata(metadata: StructuredFileSection['metadata']) {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 256) : value])
  )
}

/** No cache/agent loop: each request reads one authorized, bounded snapshot. */
export async function readAssistantDocument(
  args: Record<string, unknown>,
  resolveInputPath: (filePath: string) => string,
  signal?: AbortSignal
) {
  if (typeof args.file_path !== 'string' || !args.file_path.trim() || args.file_path.length > 4096) {
    throw new Error('file_path is required and must be a nonempty path of at most 4096 characters')
  }
  const known = new Set([
    'file_path',
    'cursor',
    'start_page',
    'start_section',
    'max_pages',
    'max_sections',
    'max_chars'
  ])
  if (Object.keys(args).some((key) => !known.has(key))) throw new Error('Unknown read_document argument')
  const maxChars = integer(args, 'max_chars', 12000, 256, 24000)
  const maxSections = integer(args, 'max_sections', 8, 1, 20)
  const maxPages = integer(args, 'max_pages', 3, 1, 10)
  const startPage = integer(args, 'start_page', 1, 1, 1_000_000)
  const startSection = integer(args, 'start_section', 1, 1, 1_000_000)
  if (args.cursor !== undefined && (args.start_page !== undefined || args.start_section !== undefined)) {
    throw new Error('Do not combine cursor with start_page or start_section')
  }
  const cursor = args.cursor === undefined ? undefined : decode(args.cursor)
  // Always reauthorize, including continuation requests; cursors grant no access.
  const canonicalPath = resolveInputPath(args.file_path)
  const ext = path.extname(canonicalPath).toLowerCase()
  const isDocument = documentExtensions.has(ext)
  if (!isDocument && !textExtensions.has(ext))
    throw new Error('Unsupported format; use PDF/DOCX/XLSX/PPTX or text/JSON')
  if (ext !== '.pdf' && args.start_page !== undefined) throw new Error('start_page is only valid for PDF')
  if ((!isDocument || ext === '.pdf') && args.start_section !== undefined)
    throw new Error('start_section is only valid for Office')
  if (activeReads >= 2) throw new Error('Document reader busy (two concurrent reads); retry after a read finishes')
  activeReads++
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    if (signal?.aborted) throw new Error('Document read cancelled')
    const before = await fs.stat(canonicalPath, { bigint: true })
    if (!before.isFile()) throw new Error('Document input must be a regular file')
    const limit = (isDocument ? 64 : 256) * MiB
    if (before.size > BigInt(limit)) throw new Error(`File exceeds the ${limit / MiB} MiB read limit; split it first`)
    handle = await fs.open(canonicalPath, 'r')
    const stat = await handle.stat({ bigint: true })
    // Revalidate realpath after opening, and bind the open descriptor to the
    // authorized file. Reject replacement/symlink races instead of reading it.
    const rechecked = resolveInputPath(args.file_path)
    if (rechecked !== canonicalPath || revision(stat) !== revision(before))
      throw new Error('File changed while opening; retry')
    const source = createHash('sha256').update(canonicalPath).digest('hex')
    const fileRevision = revision(stat)
    if (cursor && (cursor.source !== source || cursor.revision !== fileRevision)) {
      throw new Error('Stale document cursor (file changed or different path); restart without cursor')
    }
    const size = Number(stat.size)
    const position: Cursor = cursor ?? {
      v: 1,
      source,
      revision: fileRevision,
      expires: Date.now() + 30 * 60_000,
      section: ext === '.pdf' ? startPage - 1 : startSection - 1,
      offset: 0,
      byte: 0
    }
    const beganAtStart = position.section === 0 && position.offset === 0 && position.byte === 0
    const chunks: Array<{
      section: number
      char_start: number
      char_end: number
      section_complete: boolean
      text: string
      provenance: Record<string, unknown>
    }> = []
    const ocrPages: number[] = []
    let next: Cursor | undefined
    let totalSections: number | undefined
    let totalPages: number | undefined
    let parserVersion: number | undefined
    let encoding: string | undefined
    let returnedChars = 0
    if (!isDocument) {
      if (position.byte > size || position.section !== 0) throw new Error('Invalid document cursor position')
      const bom = Buffer.alloc(3)
      await handle.read(bom, 0, 3, 0)
      encoding =
        bom[0] === 0xff && bom[1] === 0xfe ? 'utf-16le' : bom[0] === 0xfe && bom[1] === 0xff ? 'utf-16be' : 'utf-8'
      // UTF-8 needs at most four bytes per character. Streaming decode keeps an
      // incomplete trailing code point out of this window; it is reread next time.
      const buffer = Buffer.alloc(Math.min(size - position.byte, maxChars * 4 + 4))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position.byte)
      let text: string
      try {
        text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead), {
          stream: position.byte + bytesRead < size
        })
      } catch {
        throw new Error('Text encoding is invalid; provide UTF-8 or BOM-marked UTF-16 text (no lossy decode performed)')
      }
      if (text.includes('\0')) throw new Error('Binary/NUL content is not supported as text')
      text = boundedText(text, 0, maxChars)
      const consumed = Buffer.byteLength(text, encoding === 'utf-8' ? 'utf8' : 'utf16le')
      if (!consumed && position.byte < size) throw new Error('Text reader made no progress; invalid encoding')
      returnedChars = text.length
      totalSections = 1
      const byteEnd = position.byte + consumed
      chunks.push({
        section: 1,
        char_start: position.offset,
        char_end: position.offset + text.length,
        section_complete: byteEnd === size,
        text,
        provenance: { byte_start: position.byte, byte_end: byteEnd, encoding }
      })
      if (byteEnd < size) next = { ...position, byte: byteEnd, offset: position.offset + text.length }
    } else {
      // A descriptor-sized read prevents file growth from causing an unbounded
      // readFile allocation. Parsers only see this snapshot, never the live path.
      const data = Buffer.alloc(size)
      let read = 0
      while (read < size) {
        const result = await handle.read(data, read, size - read, read)
        if (!result.bytesRead) throw new Error('File changed during document read; retry')
        read += result.bytesRead
      }
      const { fileStorage } = await import('@main/services/FileStorage')
      const parsed = await fileStorage.readStructuredExternalDocument(canonicalPath, data, {
        startPage: position.section + 1,
        maxPages,
        signal
      })
      parserVersion = parsed.parserVersion
      totalPages = parsed.totalPages
      totalSections = ext === '.pdf' ? totalPages : parsed.sections.length
      if (position.section >= (totalSections ?? 0) && (totalSections !== 0 || position.section !== 0)) {
        throw new Error('start_section or cursor is outside the document')
      }
      let index = ext === '.pdf' ? 0 : position.section
      let offset = position.offset
      while (index < parsed.sections.length && chunks.length < maxSections && returnedChars < maxChars) {
        const section = parsed.sections[index]
        if (offset > section.text.length) throw new Error('Invalid document cursor character offset')
        const sectionNumber = ext === '.pdf' ? section.metadata.page! : index + 1
        if (ext === '.pdf' && !section.text.trim()) ocrPages.push(sectionNumber)
        const text = boundedText(section.text, offset, maxChars - returnedChars)
        if (!text && offset < section.text.length) break
        const end = offset + text.length
        chunks.push({
          section: sectionNumber,
          char_start: offset,
          char_end: end,
          section_complete: end === section.text.length,
          text,
          provenance: boundedMetadata(section.metadata)
        })
        returnedChars += text.length
        if (end < section.text.length) {
          offset = end
          break
        }
        index++
        offset = 0
      }
      const nextSection = ext === '.pdf' ? position.section + index : index
      if (nextSection < (totalSections ?? 0)) next = { ...position, section: nextSection, offset }
    }
    if (signal?.aborted) throw new Error('Document read cancelled')
    const after = await handle.stat({ bigint: true })
    const current = await fs.stat(resolveInputPath(args.file_path), { bigint: true })
    if (revision(after) !== fileRevision || revision(current) !== fileRevision)
      throw new Error('File changed during read; restart without cursor')
    const partial = !beganAtStart || Boolean(next)
    return {
      file_path: canonicalPath,
      format: ext.slice(1),
      file_bytes: size,
      revision: fileRevision,
      parser_version: parserVersion,
      encoding,
      offset_unit: 'UTF-16 code units; end exclusive',
      coverage: isDocument
        ? 'extracted text only; images, layout and embedded objects are not fully read'
        : 'source text',
      status: ocrPages.length ? 'ocr_required' : partial ? 'partial' : returnedChars ? 'complete' : 'no_text',
      partial,
      text_complete: !partial && ocrPages.length === 0,
      whole_file_read: !isDocument && !partial,
      returned_chars: returnedChars,
      total_sections: totalSections,
      total_pages: totalPages,
      chunks,
      next_cursor: next ? encode(next) : null,
      continuation: next
        ? 'Call read_document with the same file_path and next_cursor; do not infer unseen content.'
        : null,
      ocr_required_pages: ocrPages,
      guidance: ocrPages.length
        ? 'These PDF pages have no extractable text (possibly scanned or blank). Use ocr_file with file_path and these pages; this tool did not run OCR.'
        : ext === '.xlsx'
          ? 'Excel XML extraction returns raw/cached cell values and formulas, without recalculation. Styles/date formatting and layout are not interpreted; formatted-date fidelity and workbook completeness are not guaranteed.'
          : isDocument
            ? 'Text extraction is not a visual or whole-file inspection. DOCX page numbers reflect explicit page breaks, not rendered pagination.'
            : null
    }
  } finally {
    activeReads--
    await handle?.close()
  }
}
