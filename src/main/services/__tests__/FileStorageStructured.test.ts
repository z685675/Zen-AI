import type * as FsModule from 'node:fs'
import type * as OsModule from 'node:os'
import type * as PathModule from 'node:path'

import AdmZip from 'adm-zip'
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
