import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import AdmZip from 'adm-zip'
import { PDFDocument, rgb } from 'pdf-lib'
import PptxGenJS from 'pptxgenjs'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.unmock('node:path')

import { MAX_DELIVERY_VALIDATION_BYTES, verifyPresentedOutput } from '../assistantDeliveryValidation'
import { createDocxBuffer } from '../assistantDocx'
import { createXlsxBuffer } from '../assistantXlsx'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function check(name: string, buffer: Buffer) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'zen-delivery-check-'))
  directories.push(directory)
  const file = path.join(directory, name)
  await fs.writeFile(file, buffer)
  return verifyPresentedOutput(file, buffer.length)
}

describe('script-generated deliverable validation', () => {
  it.each(['txt', 'md', 'csv'])('validates real %s content', async (format) => {
    expect(await check(`output.${format}`, Buffer.from('Actual result'))).toMatchObject({
      verified: true,
      verification_scope: 'structure-and-content',
      verification: { passed: true }
    })
  })

  it.each(['txt', 'md', 'csv'])('rejects empty %s instead of equating existence with success', async (format) => {
    await expect(check(`output.${format}`, Buffer.from('  \n'))).rejects.toThrow('no visible content')
  })

  it('rejects malformed Markdown', async () => {
    await expect(check('broken.md', Buffer.from('# Report\n```\nunfinished'))).rejects.toThrow('unclosed code fence')
  })

  it.each(['docx', 'xlsx', 'pptx', 'pdf'])('rejects text renamed as %s', async (format) => {
    await expect(check(`fake.${format}`, Buffer.from('Plain text, not this format'))).rejects.toThrow()
  })

  it('checks DOCX body content without launching a renderer', async () => {
    const result = await check('report.DOCX', await createDocxBuffer('Report', 'Actual content', []))
    expect(result.verification?.checks).toContain('docx-body-content')
    expect(result.verification?.details.body_text_characters).toBeGreaterThan(0)
    expect(result.verification?.details.render_verification).not.toBe('passed')
    expect(result.warnings.join(' ')).toContain('visual layout')
  })

  it('rejects a structurally valid but empty Word body', async () => {
    const zip = new AdmZip(await createDocxBuffer('Report', 'Actual content', []))
    zip.updateFile(
      'word/document.xml',
      Buffer.from(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>'
      )
    )
    await expect(check('empty.docx', zip.toBuffer())).rejects.toThrow('no visible text')
  })

  it('reports workbook sheets, actual data and formulas', async () => {
    const buffer = createXlsxBuffer(
      {
        sheets: [
          {
            name: '收入',
            rows: [
              ['月份', '金额'],
              ['一月', 10],
              ['合计', { formula: 'SUM(B2:B2)', result: 10 }]
            ]
          },
          { name: '备注', rows: [['来源', '用户上传文件']] }
        ]
      },
      [],
      'Report'
    )
    const result = await check('report.xlsx', buffer)
    expect(result.verification?.details).toMatchObject({ sheets: 2, formula_cells: 1, uncached_formula_cells: 0 })
    expect(result.verification?.details.sheet_names).toContain('收入')
  })

  it('rejects missing workbook-to-sheet bindings', async () => {
    const zip = new AdmZip(createXlsxBuffer(undefined, [['Value'], ['1']], 'Report'))
    zip.updateFile(
      'xl/workbook.xml',
      Buffer.from(zip.readAsText('xl/workbook.xml').replace('r:id="rId1"', 'r:id="missing"'))
    )
    await expect(check('unbound.xlsx', zip.toBuffer())).rejects.toThrow('has no workbook relationship')
  })

  it('rejects an Excel error instead of presenting it as a correct total', async () => {
    const zip = new AdmZip(createXlsxBuffer(undefined, [['Value'], ['1']], 'Report'))
    zip.updateFile(
      'xl/worksheets/sheet1.xml',
      Buffer.from(
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="e"><f>1/0</f><v>#DIV/0!</v></c></row></sheetData></worksheet>'
      )
    )
    await expect(check('error.xlsx', zip.toBuffer())).rejects.toThrow('Excel error')
  })

  it('rejects missing shared strings instead of counting their indexes as source data', async () => {
    const zip = new AdmZip(createXlsxBuffer(undefined, [['Value'], ['1']], 'Report'))
    zip.deleteFile('xl/sharedStrings.xml')
    zip.updateFile(
      'xl/worksheets/sheet1.xml',
      Buffer.from(
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>'
      )
    )
    await expect(check('missing-strings.xlsx', zip.toBuffer())).rejects.toThrow()
  })

  it('discloses unavailable cached formula results rather than pretending recalculation was checked', async () => {
    const zip = new AdmZip(createXlsxBuffer(undefined, [['Value'], ['1']], 'Report'))
    zip.updateFile(
      'xl/worksheets/sheet1.xml',
      Buffer.from(
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>1+1</f><v/></c></row></sheetData></worksheet>'
      )
    )
    const result = await check('uncached.xlsx', zip.toBuffer())
    expect(result).toMatchObject({ verified: false, verification_scope: 'structure-only' })
    expect(result.verification?.details.uncached_formula_cells).toBe(1)
    expect(result.warnings.join(' ')).toContain('recalculation is not verified')
  })

  it('rejects a workbook with no actual data cells', async () => {
    const zip = new AdmZip(createXlsxBuffer(undefined, [['Value'], ['1']], 'Report'))
    zip.updateFile(
      'xl/worksheets/sheet1.xml',
      Buffer.from(
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'
      )
    )
    await expect(check('empty.xlsx', zip.toBuffer())).rejects.toThrow('no data or formula cells')
  })

  it('checks PDF structure and page counts without rendering', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage().drawText('Actual report', { x: 40, y: 100, color: rgb(0, 0, 0) })
    const result = await check('report.pdf', Buffer.from(await pdf.save()))
    expect(result.verification?.details).toMatchObject({ pages: 1, render_verification: 'skipped' })
  })

  it('rejects a PDF with pages but no content', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage()
    await expect(check('empty.pdf', Buffer.from(await pdf.save()))).rejects.toThrow('no page content')
  })

  it('checks actual linked PPT pages rather than only counting package filenames', async () => {
    const deck = new PptxGenJS()
    deck.addSlide().addText('Actual report', { x: 1, y: 1, w: 5, h: 1 })
    const result = await check('report.pptx', (await deck.write({ outputType: 'nodebuffer' })) as Buffer)
    expect(result.verification?.details).toMatchObject({ slides: 1, presentation_slides: 1 })
    expect(result.verification?.checks).toContain('pptx-linked-slides')
  })

  it('does not relax package checks for script output with dangling content-type references', async () => {
    const deck = new PptxGenJS()
    deck.addSlide().addText('Report', { x: 1, y: 1, w: 5, h: 1 })
    const zip = new AdmZip((await deck.write({ outputType: 'nodebuffer' })) as Buffer)
    zip.updateFile(
      '[Content_Types].xml',
      Buffer.from(
        zip
          .readAsText('[Content_Types].xml')
          .replace(
            '</Types>',
            '<Override PartName="/ppt/slideMasters/missing.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/></Types>'
          )
      )
    )
    await expect(check('dangling.pptx', zip.toBuffer())).rejects.toThrow('targets missing part')
  })

  it('rejects a PPT package whose apparent page is not linked into the presentation', async () => {
    const deck = new PptxGenJS()
    deck.addSlide().addText('Report', { x: 1, y: 1, w: 5, h: 1 })
    const zip = new AdmZip((await deck.write({ outputType: 'nodebuffer' })) as Buffer)
    zip.updateFile(
      'ppt/presentation.xml',
      Buffer.from(zip.readAsText('ppt/presentation.xml').replace(/(<p:sldId\b[^>]*\br:id=")[^"]+/, '$1missing'))
    )
    await expect(check('unbound.pptx', zip.toBuffer())).rejects.toThrow('no valid presentation relationship')
  })

  it('detects a file changing during delivery and closes the handle', async () => {
    const stat = vi
      .fn()
      .mockResolvedValueOnce({ isFile: () => true, size: 3, mtimeMs: 1 })
      .mockResolvedValueOnce({ isFile: () => true, size: 3, mtimeMs: 2 })
    const close = vi.fn()
    vi.spyOn(fs, 'open').mockResolvedValueOnce({
      stat,
      close,
      read: vi
        .fn()
        .mockImplementationOnce(async (buffer: Buffer) => {
          buffer.write('abc')
          return { bytesRead: 3 }
        })
        .mockResolvedValueOnce({ bytesRead: 0 })
    } as any)
    await expect(verifyPresentedOutput('changing.txt', 3)).rejects.toThrow('changed during validation')
    expect(close).toHaveBeenCalledOnce()
  })

  it('caps a file that grows after the presentation stat without reading it', async () => {
    const read = vi.fn()
    const close = vi.fn()
    vi.spyOn(fs, 'open').mockResolvedValueOnce({
      read,
      close,
      stat: vi.fn().mockResolvedValue({
        isFile: () => true,
        size: MAX_DELIVERY_VALIDATION_BYTES + 1
      })
    } as any)
    expect(await verifyPresentedOutput('growing.xlsx', 1)).toMatchObject({
      verified: false,
      verification_scope: 'existence-only'
    })
    expect(read).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('bounds reads for oversized files and does not claim content validation', async () => {
    const result = await verifyPresentedOutput('large.xlsx', MAX_DELIVERY_VALIDATION_BYTES + 1)
    expect(result).toMatchObject({ verified: false, verification_scope: 'existence-only' })
    expect(result.warnings.join(' ')).toContain('limit')
  })

  it('bounds expanded Office packages before XML parsing', async () => {
    const zip = new AdmZip(await createDocxBuffer('Report', 'Actual content', []))
    zip.addFile('word/oversized.xml', Buffer.alloc(65 * 1024 * 1024, 32))
    await expect(check('oversized.docx', zip.toBuffer())).rejects.toThrow('safety limits')
  })
})
