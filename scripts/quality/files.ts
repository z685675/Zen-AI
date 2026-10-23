import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as XLSX from '@e965/xlsx'
import AdmZip from 'adm-zip'
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import PptxGenJS from 'pptxgenjs'
import sharp from 'sharp'

import type { FileKind } from './matrix'
import { checkAnswer } from './scenarios'

export const FIXTURE_VERSION = 'office-gold-v1'
const facts = ['ZX7319', 'LIN', '120', '230', '350']
const text = 'Project ZX7319; Owner LIN; Amounts: 120, 230, 350; Total: 700'
export const hashBytes = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

export async function safeFile(root: string, file: string, maxBytes = 64 * 1024 * 1024) {
  const relative = path.relative(await realpath(root), await realpath(file))
  const info = await lstat(file)
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.size > maxBytes
  )
    throw new Error('文件越界、符号链接或超过证据大小限制。')
  return readFile(file)
}

export async function generateFiles(directory: string) {
  await mkdir(directory, { recursive: true })
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph('合成办公文件验收资料'),
          new Paragraph(text),
          new Table({
            rows: [
              new TableRow({
                children: ['A:120', 'B:230', 'C:350'].map(
                  (value) => new TableCell({ children: [new Paragraph(value)] })
                )
              })
            ]
          })
        ]
      }
    ]
  })
  const spreadsheet = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Project', 'Owner', 'Amount'],
    ['ZX7319', 'LIN', 120],
    ['ZX7319', 'LIN', 230],
    ['ZX7319', 'LIN', 350],
    ['TOTAL', '', 700]
  ])
  sheet.C5 = { t: 'n', v: 700, f: 'SUM(C2:C4)' }
  XLSX.utils.book_append_sheet(spreadsheet, sheet, 'Sales')
  XLSX.utils.book_append_sheet(
    spreadsheet,
    XLSX.utils.aoa_to_sheet([
      ['Date', 'Note'],
      ['2026-12-18', '原件只读']
    ]),
    'Notes'
  )
  const ppt = new PptxGenJS()
  ppt.author = 'Zen quality synthetic fixture'
  ppt.addSlide().addText(text, { x: 0.5, y: 0.5, w: 9, h: 2, fontSize: 24 })
  ppt.addSlide().addText('A 120\nB 230\nC 350\nTotal 700', { x: 0.5, y: 0.5, w: 9, h: 3 })
  const pdf = await PDFDocument.create()
  pdf
    .addPage([640, 400])
    .drawText(text, { x: 30, y: 320, size: 12, font: await pdf.embedFont(StandardFonts.Helvetica) })
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500"><rect width="1200" height="500" fill="white"/><g fill="black" font-family="sans-serif" font-size="42"><text x="40" y="100">Project ZX7319</text><text x="40" y="200">Owner LIN</text><text x="40" y="300">Amounts: 120, 230, 350</text><text x="40" y="400">Total: 700</text></g></svg>`
  )
  const content: Record<FileKind, Buffer> = {
    json: Buffer.from(
      JSON.stringify({ project: 'ZX7319', owner: 'LIN', amounts: [120, 230, 350], total: 700 }, null, 2)
    ),
    docx: await Packer.toBuffer(doc),
    xlsx: XLSX.write(spreadsheet, { type: 'buffer', bookType: 'xlsx' }),
    pptx: Buffer.from((await ppt.write({ outputType: 'nodebuffer' })) as ArrayBuffer),
    pdf: Buffer.from(await pdf.save({ useObjectStreams: false })),
    png: await sharp(svg).png().toBuffer(),
    jpg: await sharp(svg).jpeg({ quality: 95 }).toBuffer()
  }
  const files = {} as Record<FileKind, { file: string; sha256: string; bytes: number }>
  for (const [format, bytes] of Object.entries(content) as Array<[FileKind, Buffer]>) {
    const file = path.join(directory, `quality-source.${format}`)
    await writeFile(file, bytes, { flag: 'wx' })
    files[format] = { file, sha256: hashBytes(bytes), bytes: bytes.length }
  }
  await writeFile(
    path.join(directory, 'fixture-manifest.json'),
    JSON.stringify({ version: FIXTURE_VERSION, facts, files }, null, 2),
    { flag: 'wx' }
  )
  return files
}

/** Independent of the product's Office readers. An existing file is not proof of correct content. */
export async function inspectOutput(
  root: string,
  file: string,
  format: FileKind,
  required = ['ZX7319', '700', '120', '230', '350', 'LIN']
) {
  const bytes = await safeFile(root, file)
  let extracted = ''
  let pages: number | null = null
  if (['docx', 'xlsx', 'pptx'].includes(format)) {
    const zip = new AdmZip(bytes)
    const entries = zip.getEntries()
    if (entries.length > 10000 || entries.reduce((sum, entry) => sum + entry.header.size, 0) > 64 * 1024 * 1024)
      throw new Error('办公产物解压后超过上限。')
    if (!zip.getEntry('[Content_Types].xml')) throw new Error('不是有效的OOXML办公文件。')
    const pattern =
      format === 'docx'
        ? /^word\/document\.xml$/
        : format === 'xlsx'
          ? /^xl\/(?:worksheets\/sheet\d+|sharedStrings)\.xml$/
          : /^ppt\/slides\/slide\d+\.xml$/
    const selected = entries.filter((entry) => pattern.test(entry.entryName))
    if (!selected.length) throw new Error('办公产物没有正文、工作表或幻灯片。')
    extracted = selected
      .map((entry) =>
        entry
          .getData()
          .toString('utf8')
          .replace(/<[^>]+>/g, ' ')
      )
      .join('\n')
    pages = selected.length
    if (format === 'xlsx') {
      const workbook = XLSX.read(bytes, { type: 'buffer', cellFormula: true })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      if (
        !sheet ||
        sheet.C2?.v !== 120 ||
        sheet.C3?.v !== 230 ||
        sheet.C4?.v !== 350 ||
        sheet.C5?.f?.replace(/\s+/g, '').toUpperCase() !== 'SUM(C2:C4)' ||
        (sheet.C5.v !== undefined && Number(sheet.C5.v) !== 700)
      )
        throw new Error('Excel原始数据/合计公式/缓存结果错误。')
    }
  } else if (format === 'pdf') {
    pages = (await PDFDocument.load(bytes)).getPageCount()
    if (!pages) throw new Error('PDF没有页面。')
    // A parser different from the product worker. Do not mistake metadata or the model's response for PDF text.
    const { PDFParse } = await import('pdf-parse')
    const reader = new PDFParse({ data: new Uint8Array(bytes) })
    try {
      extracted = (await reader.getText()).text
    } finally {
      await reader.destroy()
    }
  } else if (format === 'json') extracted = JSON.stringify(JSON.parse(bytes.toString('utf8')))
  else throw new Error('图像产物的语义需要视觉验收，不以文件存在冒充通过。')
  for (const fact of checkAnswer(extracted, required).missing) throw new Error(`实际${format}产物缺少必要内容：${fact}`)
  return {
    format,
    sha256: hashBytes(bytes),
    bytes: bytes.length,
    pages,
    required,
    structurallyReadable: true,
    semanticBasis: 'independent-parser-required-facts; visual-layout-not-judged'
  }
}

export async function checkOriginals(root: string, files: Awaited<ReturnType<typeof generateFiles>>) {
  for (const fixture of Object.values(files))
    if (hashBytes(await safeFile(root, fixture.file)) !== fixture.sha256) throw new Error('上传原件被覆盖或修改。')
}

export async function generateLargeFiles(directory: string) {
  await mkdir(directory, { recursive: true })
  const files: Array<{ file: string; sha256: string; bytes: number }> = []
  for (const name of ['large-a.json', 'large-b.json']) {
    const bytes = Buffer.from(
      JSON.stringify({
        amounts: name.includes('-a') ? [35, 15] : [25, 25],
        padding: '归档资料。'.repeat(450000),
        tail: name.includes('-a') ? 'TAIL-A-7319' : 'TAIL-B-4621'
      })
    )
    const file = path.join(directory, name)
    await writeFile(file, bytes, { flag: 'wx' })
    files.push({ file, sha256: hashBytes(bytes), bytes: bytes.length })
  }
  if (files.reduce((sum, file) => sum + file.bytes, 0) <= 10 * 1024 * 1024)
    throw new Error('多附件样本未达到10MiB，不能冒充大附件测试。')
  const corrupt = path.join(directory, 'corrupt.docx')
  await writeFile(corrupt, 'This is deliberately not an OOXML archive.', { flag: 'wx' })
  return { files, corrupt }
}
