import type * as FsModule from 'node:fs'
import * as mockedFs from 'node:fs'
import type * as OsModule from 'node:os'
import type * as PathModule from 'node:path'

import * as XLSX from '@e965/xlsx'
import AdmZip from 'adm-zip'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { fileStorage } from '../FileStorage'

describe('FileStorage structured Office parsing', () => {
  let tempDir = ''
  let fs: typeof FsModule
  let os: typeof OsModule
  let path: typeof PathModule

  beforeAll(async () => {
    fs = await vi.importActual('node:fs')
    os = await vi.importActual('node:os')
    path = await vi.importActual('node:path')
  })

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-structured-file-'))
    ;(fileStorage as unknown as { storageDir: string }).storageDir = tempDir
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('extracts slide numbers from PPTX in numeric order', async () => {
    const zip = new AdmZip()
    zip.addFile('ppt/slides/slide10.xml', Buffer.from('<p:sld><a:t>第十页</a:t></p:sld>'))
    zip.addFile('ppt/slides/slide2.xml', Buffer.from('<p:sld><a:t>第二页</a:t></p:sld>'))
    zip.writeZip(path.join(tempDir, 'slides.pptx'))

    const result = await fileStorage.readStructuredFile({} as Electron.IpcMainInvokeEvent, 'slides.pptx')

    expect(result.sections).toEqual([
      { text: '第二页', metadata: { slide: 1, section: '第二页' } },
      { text: '第十页', metadata: { slide: 2, section: '第十页' } }
    ])
  })

  it('extracts sheet names, ranges and formulas regardless of XML attribute order', async () => {
    const zip = new AdmZip()
    zip.addFile(
      'xl/workbook.xml',
      Buffer.from('<workbook><sheets><sheet r:id="rId9" sheetId="1" name="经营 &amp; 数据"/></sheets></workbook>')
    )
    zip.addFile(
      'xl/_rels/workbook.xml.rels',
      Buffer.from('<Relationships><Relationship Target="worksheets/sheet7.xml" Id="rId9"/></Relationships>')
    )
    zip.addFile('xl/sharedStrings.xml', Buffer.from('<sst><si><t>收入</t></si></sst>'))
    zip.addFile(
      'xl/worksheets/sheet7.xml',
      Buffer.from(
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>SUM(B2:B3)</f><v>30</v></c></row><row r="3"><c r="B3"><v>20</v></c></row></sheetData></worksheet>'
      )
    )
    zip.writeZip(path.join(tempDir, 'workbook.xlsx'))

    const result = await fileStorage.readStructuredFile({} as Electron.IpcMainInvokeEvent, 'workbook.xlsx')

    expect(result.sections).toHaveLength(2)
    expect(result.sections[0]).toMatchObject({
      metadata: { sheet: '经营 & 数据', table: 1, cellRange: 'A1:B1' }
    })
    expect(result.sections[0].text).toContain('B1: =SUM(B2:B3) -> 30')
    expect(result.sections[1]).toMatchObject({
      metadata: { sheet: '经营 & 数据', table: 2, cellRange: 'A3:B3' }
    })
  })

  it('preserves worksheet structure when reading a normal XLSX workbook', async () => {
    const workbook = XLSX.utils.book_new()
    const sheet = XLSX.utils.aoa_to_sheet([
      ['产品', '销售额', '数量'],
      ['产品A', 10000, 20],
      ['产品B', 8500, 15]
    ])
    sheet.C4 = { t: 'n', f: 'SUM(C2:C3)', v: 35, w: '35' }
    sheet['!ref'] = 'A1:C4'
    XLSX.utils.book_append_sheet(workbook, sheet, '经营数据')
    fs.writeFileSync(
      path.join(tempDir, 'normal.xlsx'),
      XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer', cellStyles: true })
    )

    const result = await fileStorage.readStructuredFile({} as Electron.IpcMainInvokeEvent, 'normal.xlsx')

    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]).toMatchObject({
      metadata: { sheet: '经营数据', cellRange: 'A1:C4' }
    })
    expect(result.sections[0].text).toContain('| 行号 | A | B | C |')
    expect(result.sections[0].text).toContain('| 2 | 产品A | 10000 | 20 |')
    expect(result.sections[0].text).toContain('=SUM(C2:C3)')
  })

  it('extracts embedded Office images for multimodal prompts', async () => {
    const zip = new AdmZip()
    zip.addFile(
      'word/document.xml',
      Buffer.from('<w:document><w:body><w:p><w:r><w:t>报告</w:t></w:r></w:p></w:body></w:document>')
    )
    zip.addFile('word/media/image1.png', Buffer.from([137, 80, 78, 71]))
    zip.writeZip(path.join(tempDir, 'illustrated.docx'))

    const result = await fileStorage.readEmbeddedImages({} as Electron.IpcMainInvokeEvent, 'illustrated.docx')

    expect(result).toEqual([
      { name: 'image1.png', mediaType: 'image/png', base64: Buffer.from([137, 80, 78, 71]).toString('base64') }
    ])
  })

  it('adds slide location metadata to embedded PPTX images', async () => {
    const zip = new AdmZip()
    zip.addFile('ppt/slides/slide2.xml', Buffer.from('<p:sld><p:pic><a:blip r:embed="rId7"/></p:pic></p:sld>'))
    zip.addFile(
      'ppt/slides/_rels/slide2.xml.rels',
      Buffer.from('<Relationships><Relationship Id="rId7" Target="../media/image3.png"/></Relationships>')
    )
    zip.addFile('ppt/media/image3.png', Buffer.from([137, 80, 78, 71]))
    zip.writeZip(path.join(tempDir, 'located.pptx'))

    const result = await fileStorage.readEmbeddedImages({} as Electron.IpcMainInvokeEvent, 'located.pptx')

    expect(result[0]).toMatchObject({ name: 'image3.png', location: '幻灯片 2' })
  })

  it('renders PDF pages for visual fallback when native PDF input is unavailable', async () => {
    const document = await PDFDocument.create()
    const page = document.addPage([400, 300])
    page.drawText('Scanned page')
    fs.writeFileSync(path.join(tempDir, 'scanned.pdf'), await document.save())

    const result = await fileStorage.readEmbeddedImages({} as Electron.IpcMainInvokeEvent, 'scanned.pdf')

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ name: 'page-1.png', mediaType: 'image/png' })
    expect(result[0].base64.length).toBeGreaterThan(100)
  })

  it('renders only explicitly requested PDF pages', async () => {
    const document = await PDFDocument.create()
    document.addPage([400, 300])
    document.addPage([400, 300])
    document.addPage([400, 300])
    fs.writeFileSync(path.join(tempDir, 'pages.pdf'), await document.save())

    const result = await fileStorage.readEmbeddedImages({} as Electron.IpcMainInvokeEvent, 'pages.pdf', {
      pageNumbers: [3],
      maxPages: 1
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ name: 'page-3.png', page: 3 })
  })

  it('rejects stored-file path traversal', async () => {
    await expect(fileStorage.readStructuredFile({} as Electron.IpcMainInvokeEvent, '../outside.txt')).rejects.toThrow(
      '文件路径无效'
    )
  })

  it('copies Agent attachments only into the validated workspace directory', async () => {
    const sourcePath = path.join(tempDir, 'source.txt')
    fs.writeFileSync(sourcePath, 'attachment')

    const destination = await fileStorage.copyFileToAgentAttachment(
      {} as Electron.IpcMainInvokeEvent,
      'source.txt',
      tempDir,
      'session-1',
      'message-1',
      '01-source.txt'
    )

    expect(path.normalize(destination)).toBe(
      path.join(tempDir, '.zen-ai', 'ui-attachments', 'session-1', 'message-1', '01-source.txt')
    )
    expect(mockedFs.promises.copyFile).toHaveBeenCalledWith(expect.stringMatching(/[\\/]source\.txt$/), destination)
  })

  it('rejects traversal in Agent attachment identifiers and file names', async () => {
    await expect(
      fileStorage.copyFileToAgentAttachment(
        {} as Electron.IpcMainInvokeEvent,
        'source.txt',
        tempDir,
        '../outside',
        'message-1',
        'file.txt'
      )
    ).rejects.toThrow('智能助手附件标识无效')

    await expect(
      fileStorage.copyFileToAgentAttachment(
        {} as Electron.IpcMainInvokeEvent,
        'source.txt',
        tempDir,
        'session-1',
        'message-1',
        '..\\outside.txt'
      )
    ).rejects.toThrow('智能助手附件文件名无效')
  })

  it('extracts DOCX headings, explicit page breaks and tables', async () => {
    const zip = new AdmZip()
    zip.addFile(
      'word/document.xml',
      Buffer.from(
        [
          '<w:document><w:body>',
          '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>项目概览</w:t></w:r></w:p>',
          '<w:p><w:r><w:t>第一页内容</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>',
          '<w:p><w:r><w:t>第二页内容</w:t></w:r></w:p>',
          '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>35%</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
          '</w:body></w:document>'
        ].join('')
      )
    )
    zip.writeZip(path.join(tempDir, 'document.docx'))

    const result = await fileStorage.readStructuredFile({} as Electron.IpcMainInvokeEvent, 'document.docx')

    expect(result.sections.some((section) => section.metadata.page === 1 && section.text.includes('第一页内容'))).toBe(
      true
    )
    expect(result.sections.some((section) => section.metadata.page === 2 && section.text.includes('第二页内容'))).toBe(
      true
    )
    expect(result.sections.some((section) => section.metadata.table === 1 && section.text.includes('指标 | 35%'))).toBe(
      true
    )
  })
})
