import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as XLSX from '@e965/xlsx'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import AdmZip from 'adm-zip'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.unmock('node:path')
vi.mock('@main/utils', () => ({ toAsarUnpackedPath: (value: string) => value }))
vi.mock('@main/utils/file', async () => {
  const os = await import('node:os')
  return { getFilesDir: os.tmpdir, getNotesDir: os.tmpdir, getTempDir: os.tmpdir }
})
vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => 'test',
    getName: () => 'Zen AI',
    getLocale: () => 'en-US',
    isPackaged: false
  }
}))

import { fileStorage } from '@main/services/FileStorage'

import AssistantServer from '../assistant'
import { readAssistantDocument } from '../assistantReadDocument'

let root: string
let client: Client
let assistant: AssistantServer
const extraRoots: string[] = []

async function connect(product = true) {
  const server = new AssistantServer(
    [root],
    product
      ? {
          workspace: root,
          readNativeSkills: async () => [],
          approveOverwrite: async () => false,
          readOnly: true
        }
      : undefined
  )
  const connection = new Client({ name: 'read-document-tests', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.mcpServer.connect(b)
  await connection.connect(a)
  return { server, connection }
}

async function call(args: Record<string, unknown>) {
  const result = await client.callTool({ name: 'read_document', arguments: args })
  const text = (result.content as Array<{ type: string; text: string }>).find((item) => item.type === 'text')!.text
  return { result, text, payload: JSON.parse(text) }
}

async function writeZip(name: string, entries: Record<string, string | Buffer>) {
  const zip = new AdmZip()
  for (const [entry, content] of Object.entries(entries)) zip.addFile(entry, Buffer.from(content))
  await fs.writeFile(path.join(root, name), zip.toBuffer())
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'zen-read-document-'))
  const connected = await connect()
  assistant = connected.server
  client = connected.connection
})

afterEach(async () => {
  vi.restoreAllMocks()
  await client.close()
  await assistant.mcpServer.close()
  await Promise.all(
    [root, ...extraRoots.splice(0)].map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('read_document MCP', () => {
  it('is new-assistant only, read-only annotated, and usable in plan mode', async () => {
    const tool = (await client.listTools()).tools.find((item) => item.name === 'read_document')!
    expect(tool.annotations?.readOnlyHint).toBe(true)
    await fs.writeFile(path.join(root, 'plan.txt'), 'read in plan mode')
    expect((await call({ file_path: 'plan.txt' })).payload.whole_file_read).toBe(true)
    const legacy = await connect(false)
    try {
      expect((await legacy.connection.listTools()).tools.some((item) => item.name === 'read_document')).toBe(false)
      expect(
        (await legacy.connection.callTool({ name: 'read_document', arguments: { file_path: 'plan.txt' } })).isError
      ).toBe(true)
    } finally {
      await legacy.connection.close()
      await legacy.server.mcpServer.close()
    }
  })

  it('retrieves a long single-line JSON exactly, including Unicode, using bounded character cursors', async () => {
    const source = JSON.stringify({ value: '你好🙂"\\long-line-'.repeat(2500), tail: 'LAST_VALUE' })
    await fs.writeFile(path.join(root, 'long.json'), source)
    let cursor: string | undefined
    let restored = ''
    let calls = 0
    do {
      const { result, payload } = await call({ file_path: 'long.json', max_chars: 1025, cursor })
      expect(result.isError).not.toBe(true)
      expect(payload.returned_chars).toBeLessThanOrEqual(1025)
      expect(payload.chunks[0].char_start).toBe(restored.length)
      expect(payload.whole_file_read).toBe(false)
      expect(payload.partial).toBe(true)
      expect(payload.chunks[0].text).not.toContain('\uFFFD')
      restored += payload.chunks[0].text
      cursor = payload.next_cursor
      calls++
    } while (cursor && calls < 200)
    expect(cursor).toBeNull()
    expect(restored).toBe(source)
    expect(calls).toBeGreaterThan(30)
  })

  it('reads BOM-marked UTF-16 and preserves whitespace without lossy decoding', async () => {
    const source = '\uFEFF  spaces\r\n' + '中文🙂'.repeat(300)
    await fs.writeFile(path.join(root, 'utf16.txt'), Buffer.from(source, 'utf16le'))
    let restored = ''
    let cursor: string | undefined
    do {
      const { payload } = await call({ file_path: 'utf16.txt', max_chars: 257, cursor })
      restored += payload.chunks[0].text
      cursor = payload.next_cursor
    } while (cursor)
    expect(restored).toBe(source)
    await fs.writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xc0, 0xaf]))
    expect((await call({ file_path: 'invalid.txt' })).result.isError).toBe(true)
  })

  it('rejects malformed, tampered, expired, changed-file and cross-file cursors without ending the chat', async () => {
    await fs.writeFile(path.join(root, 'a.json'), JSON.stringify({ x: 'x'.repeat(800) }))
    await fs.copyFile(path.join(root, 'a.json'), path.join(root, 'b.json'))
    const first = (await call({ file_path: 'a.json', max_chars: 256 })).payload
    for (const cursor of ['bad', first.next_cursor + 'x', 'x'.repeat(2049)]) {
      expect((await call({ file_path: 'a.json', cursor })).result.isError).toBe(true)
    }
    expect((await call({ file_path: 'b.json', cursor: first.next_cursor })).text).toContain('Stale')
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60_000)
    expect((await call({ file_path: 'a.json', cursor: first.next_cursor })).text).toContain('expired')
    clock.mockRestore()
    await fs.writeFile(path.join(root, 'a.json'), JSON.stringify({ x: 'changed' }))
    expect((await call({ file_path: 'a.json', cursor: first.next_cursor })).text).toContain('Stale')
    expect((await call({ file_path: 'a.json' })).result.isError).not.toBe(true)
  })

  it('enforces traversal, sibling-prefix and realpath/junction authorization on every call', async () => {
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'zen-read-outside-'))
    extraRoots.push(outside)
    await fs.writeFile(path.join(outside, 'secret.txt'), 'must not leak')
    await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const file_path of [
      path.join(outside, 'secret.txt'),
      path.relative(root, path.join(outside, 'secret.txt')),
      'escape/secret.txt'
    ]) {
      const failed = await call({ file_path })
      expect(failed.result.isError).toBe(true)
      expect(failed.text).not.toContain('must not leak')
    }
    await fs.mkdir(path.join(root, 'inside'))
    await fs.writeFile(path.join(root, 'inside', 'yes.txt'), 'authorized')
    await fs.symlink(
      path.join(root, 'inside'),
      path.join(root, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect((await call({ file_path: 'alias/yes.txt' })).payload.chunks[0].text).toBe('authorized')
    expect((await call({ file_path: '.' })).result.isError).toBe(true)
  })

  it('returns DOCX heading, table and explicit page provenance with intra-section continuation', async () => {
    const long = 'Document text. '.repeat(100)
    await writeZip('report.docx', {
      'word/document.xml': `<w:document xmlns:w="w"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Heading</w:t></w:r></w:p>
      <w:p><w:r><w:t>${long}</w:t></w:r><w:br w:type="page"/></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell value</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      </w:body></w:document>`
    })
    const first = (await call({ file_path: 'report.docx', max_chars: 256 })).payload
    expect(first.chunks[0].provenance).toMatchObject({ section: 'Heading', page: 1 })
    expect(first.chunks[0].section_complete).toBe(false)
    expect(first.partial).toBe(true)
    expect(first.whole_file_read).toBe(false)
    const next = (await call({ file_path: 'report.docx', cursor: first.next_cursor })).payload
    expect(next.chunks[0].char_start).toBe(256)
    expect(first.chunks[0].text + next.chunks[0].text).toBe(`Heading\n${long}`.trim())
    expect(next.chunks[1].provenance).toMatchObject({ table: 1, page: 2 })
    const table = (await call({ file_path: 'report.docx', start_section: 2 })).payload
    expect(table.chunks[0].text).toBe('Cell value')
    expect(table.partial).toBe(true)
  })

  it('preserves XLSX sheet, cell-range and formula evidence from the existing parser', async () => {
    const book = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Revenue', 12],
      ['Cost', 4]
    ])
    sheet.B3 = { t: 'n', f: 'B1-B2', v: 8 }
    sheet['!ref'] = 'A1:B3'
    XLSX.utils.book_append_sheet(book, sheet, 'Finance')
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['second']]), 'Other')
    await fs.writeFile(path.join(root, 'book.xlsx'), XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
    const first = (await call({ file_path: 'book.xlsx', max_sections: 1 })).payload
    expect(first.chunks[0].provenance).toMatchObject({ sheet: 'Finance', cellRange: 'A1:B3' })
    expect(first.chunks[0].text).toContain('=B1-B2')
    expect(first.next_cursor).toBeTruthy()
    const second = (await call({ file_path: 'book.xlsx', cursor: first.next_cursor })).payload
    expect(second.chunks[0].provenance.sheet).toBe('Other')
    expect(second.next_cursor).toBeNull()
  })

  it('returns bounded PPTX slides and notes without embedded image bytes', async () => {
    await writeZip('slides.pptx', {
      'ppt/presentation.xml': '<p:presentation xmlns:p="p"/>',
      'ppt/slides/slide1.xml': '<p:sld xmlns:p="p" xmlns:a="a"><a:t>First slide</a:t></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Second slide</a:t></p:sld>',
      'ppt/notesSlides/notesSlide2.xml': '<a:notes xmlns:a="a"><a:t>Speaker notes</a:t></a:notes>',
      'ppt/media/image.png': Buffer.from([137, 80, 78, 71])
    })
    const first = (await call({ file_path: 'slides.pptx', max_sections: 1 })).payload
    expect(first.chunks[0].provenance.slide).toBe(1)
    const second = await call({ file_path: 'slides.pptx', cursor: first.next_cursor })
    expect(second.payload.chunks[0].provenance.slide).toBe(2)
    expect(second.text).toContain('Speaker notes')
    expect(second.text).not.toContain('iVBORw==')
    expect(second.payload.whole_file_read).toBe(false)
  })

  it('reads image-heavy Office files over 16 MiB without inflating binary media', async () => {
    const zip = new AdmZip()
    zip.addFile(
      'word/document.xml',
      Buffer.from('<w:document xmlns:w="w"><w:p><w:r><w:t>Text beside a large image</w:t></w:r></w:p></w:document>')
    )
    zip.addFile('word/media/large.png', Buffer.alloc(20 * 1024 * 1024, 0x41))
    zip.getEntry('word/media/large.png')!.header.method = 0
    const data = zip.toBuffer()
    // A binary entry advertising a huge expansion must not be inflated at all.
    let entry = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    while (entry >= 0) {
      const nameLength = data.readUInt16LE(entry + 28)
      const name = data.subarray(entry + 46, entry + 46 + nameLength).toString()
      if (name.endsWith('large.png')) {
        data.writeUInt32LE(0x7fffffff, entry + 24)
        break
      }
      entry = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), entry + 46)
    }
    await fs.writeFile(path.join(root, 'illustrated.docx'), data)
    const result = await call({ file_path: 'illustrated.docx' })
    expect(result.result.isError).not.toBe(true)
    expect(result.payload.file_bytes).toBeGreaterThan(20 * 1024 * 1024)
    expect(result.payload.chunks[0].text).toBe('Text beside a large image')
    expect(result.text.length).toBeLessThan(3000)
  })

  it('passes MCP request cancellation into the isolated parser', async () => {
    await fs.writeFile(path.join(root, 'cancel.pdf'), '%PDF')
    let received: AbortSignal | undefined
    let stopped = false
    vi.spyOn(fileStorage, 'readStructuredExternalDocument').mockImplementation((_file, _data, options) => {
      received = options.signal
      return new Promise((_resolve, reject) =>
        received!.addEventListener(
          'abort',
          () => {
            stopped = true
            reject(new Error('Document read cancelled'))
          },
          { once: true }
        )
      )
    })
    const cancel = new AbortController()
    const request = client.callTool({ name: 'read_document', arguments: { file_path: 'cancel.pdf' } }, undefined, {
      signal: cancel.signal
    })
    const rejection = expect(request).rejects.toThrow()
    await vi.waitFor(() => expect(received).toBeDefined())
    cancel.abort()
    await rejection
    await vi.waitFor(() => expect(stopped).toBe(true))
    expect(received!.aborted).toBe(true)
  })

  it('extracts selected PDF pages, resumes within pages, and guides scanned pages to OCR', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage([600, 600]).drawText(Array.from({ length: 12 }, () => 'PDF text with a complete line.').join('\n'), {
      x: 10,
      y: 500,
      size: 8,
      lineHeight: 14
    })
    pdf.addPage([600, 600])
    pdf.addPage([600, 600]).drawText('Last page text')
    await fs.writeFile(path.join(root, 'pages.pdf'), await pdf.save())
    const first = await call({ file_path: 'pages.pdf', max_pages: 1, max_chars: 256 })
    expect(first.result.isError).not.toBe(true)
    expect(first.payload.chunks[0].provenance.page).toBe(1)
    expect(first.payload.total_pages).toBe(3)
    expect(first.payload.next_cursor).toBeTruthy()
    const resumed = (await call({ file_path: 'pages.pdf', cursor: first.payload.next_cursor, max_pages: 1 })).payload
    expect(resumed.chunks[0].char_start).toBe(256)
    const scanned = (await call({ file_path: 'pages.pdf', start_page: 2, max_pages: 1 })).payload
    expect(scanned.status).toBe('ocr_required')
    expect(scanned.ocr_required_pages).toEqual([2])
    expect(scanned.text_complete).toBe(false)
    expect(scanned.guidance).toContain('ocr_file')
    const last = (await call({ file_path: 'pages.pdf', cursor: scanned.next_cursor })).payload
    expect(last.chunks[0].provenance.page).toBe(3)
    expect(last.chunks[0].text).toContain('Last page')
    expect(last.next_cursor).toBeNull()
    expect(last.whole_file_read).toBe(false)
  })

  it('returns recoverable tool errors for corrupt documents, invalid ranges and oversized inputs', async () => {
    await fs.writeFile(path.join(root, 'bad.pdf'), '%PDF-1.7\ncorrupt')
    await fs.writeFile(path.join(root, 'bad.docx'), 'not a zip')
    await writeZip('malformed.docx', { 'word/document.xml': '<w:document><broken>' })
    await writeZip('missing.docx', { 'unrelated.xml': '<root/>' })
    for (const name of ['bad.pdf', 'bad.docx', 'malformed.docx', 'missing.docx']) {
      expect((await call({ file_path: name })).result.isError).toBe(true)
    }
    const big = await fs.open(path.join(root, 'large.docx'), 'w')
    await big.truncate(64 * 1024 * 1024 + 1)
    await big.close()
    expect((await call({ file_path: 'large.docx' })).text).toContain('64 MiB')
    await fs.writeFile(path.join(root, 'valid.txt'), 'still usable')
    for (const extra of [
      { max_chars: 1 },
      { max_sections: 21 },
      { max_pages: 11 },
      { start_page: 1 },
      { start_section: 2 },
      { max_chars: 300.5 }
    ]) {
      expect((await call({ file_path: 'valid.txt', ...extra })).result.isError).toBe(true)
    }
    expect((await call({ file_path: 'valid.txt' })).result.isError).not.toBe(true)
  })

  it('rejects ZIP bombs including lying central-directory sizes before unsafe inflation', async () => {
    await writeZip('ratio.docx', { 'word/document.xml': `<w:document>${' '.repeat(9 * 1024 * 1024)}</w:document>` })
    expect((await call({ file_path: 'ratio.docx' })).result.isError).toBe(true)
    const zip = new AdmZip()
    zip.addFile('word/document.xml', Buffer.from(`<w:document>${'x'.repeat(1_000_000)}</w:document>`))
    const lying = zip.toBuffer()
    const central = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    lying.writeUInt32LE(100, central + 24)
    await fs.writeFile(path.join(root, 'lying.docx'), lying)
    expect((await call({ file_path: 'lying.docx' })).result.isError).toBe(true)
    const many = new AdmZip()
    for (let i = 0; i < 4097; i++) many.addFile(`entry-${i}.xml`, Buffer.from('<r/>'))
    await fs.writeFile(path.join(root, 'many.docx'), many.toBuffer())
    expect((await call({ file_path: 'many.docx' })).text).toContain('4096')
  })

  it('caps concurrent parses, supports cancellation, and releases slots after failures', async () => {
    await fs.writeFile(path.join(root, 'pending.pdf'), '%PDF')
    const pending: Array<(value: any) => void> = []
    vi.spyOn(fileStorage, 'readStructuredExternalDocument').mockImplementation(
      () => new Promise((resolve) => pending.push(resolve))
    )
    const resolve = (name: string) => path.join(root, name)
    const first = readAssistantDocument({ file_path: 'pending.pdf' }, resolve)
    const second = readAssistantDocument({ file_path: 'pending.pdf' }, resolve)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    await expect(readAssistantDocument({ file_path: 'pending.pdf' }, resolve)).rejects.toThrow('busy')
    for (const finish of pending)
      finish({ format: 'pdf', parserVersion: 3, totalPages: 1, sections: [{ text: 'ok', metadata: { page: 1 } }] })
    await Promise.all([first, second])
    const cancel = new AbortController()
    cancel.abort()
    await expect(readAssistantDocument({ file_path: 'pending.pdf' }, resolve, cancel.signal)).rejects.toThrow(
      'cancelled'
    )
    await fs.writeFile(path.join(root, 'after.txt'), 'slot released')
    expect((await call({ file_path: 'after.txt' })).result.isError).not.toBe(true)
  })
})
