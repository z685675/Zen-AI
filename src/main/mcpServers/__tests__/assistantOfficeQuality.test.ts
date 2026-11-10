import AdmZip from 'adm-zip'
import { XMLParser } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'

import { createDocxBuffer } from '../assistantDocx'
import { validatePptxVisibleContent } from '../assistantOfficeQuality'
import { createXlsxBuffer } from '../assistantXlsx'

describe('new assistant Office quality', () => {
  it('defines a default Normal style for unstyled body and table paragraphs in independent DOCX readers', async () => {
    const zip = new AdmZip(
      await createDocxBuffer('项目说明', '正文内容\n\n| 项目 | 金额 |\n| --- | --- |\n| 材料 | 120 |', [])
    )
    const styles = zip.readAsText('word/styles.xml')
    const directStyles = new XMLParser({ ignoreAttributes: false }).parse(styles)['w:styles']['w:style']
    const normal = directStyles.filter((style: Record<string, string>) => style['@_w:styleId'] === 'Normal')
    expect(normal).toHaveLength(1)
    expect(normal[0]['@_w:default']).toBe('1')
    expect(normal[0]['@_w:type']).toBe('paragraph')
    expect(normal[0]['w:name']['@_w:val']).toBe('Normal')
  })

  it('writes intentional page breaks as native Word elements rather than visible Markdown', async () => {
    const zip = new AdmZip(await createDocxBuffer('两页方案', '第一页\n\n<!-- pagebreak -->\n\n第二页', []))
    const document = zip.readAsText('word/document.xml')
    expect(document).toContain('<w:br w:type="page"')
    expect(document).not.toContain('pagebreak')
    expect(document).toContain('第一页')
    expect(document).toContain('第二页')
  })

  it('requires explicit formula caches without silently substituting value or zero', () => {
    for (const result of [undefined, null, Number.NaN, Infinity, {}]) {
      expect(() =>
        createXlsxBuffer(
          { sheets: [{ rows: [[{ formula: '1+1', value: 2, result: result as any }]] }] },
          [],
          'Test',
          true
        )
      ).toThrow(/formula requires/)
    }
    expect(() => createXlsxBuffer({ sheets: [{ rows: [[{ formula: '1+1' }]] }] }, [], 'Test')).not.toThrow()
    for (const result of [0, false, '', 2, 'text']) {
      const zip = new AdmZip(
        createXlsxBuffer({ sheets: [{ header_rows: 0, rows: [[{ formula: '1+1', result }]] }] }, [], 'Test', true)
      )
      expect(zip.readAsText('xl/worksheets/sheet1.xml')).toContain('<f>1+1</f>')
      expect(zip.readAsText('xl/worksheets/sheet1.xml')).toContain('<v>')
    }
  })

  it('preserves numeric values while applying decimal, grouped money and Excel date formats', () => {
    const zip = new AdmZip(
      createXlsxBuffer(
        {
          sheets: [
            {
              header_rows: 0,
              rows: [
                [
                  { value: 12.345, style: 'decimal' },
                  { value: 12345.67, style: 'currency' },
                  { value: 46307, style: 'date' }
                ]
              ]
            }
          ]
        },
        [],
        'Test',
        true
      )
    )
    const sheet = zip.readAsText('xl/worksheets/sheet1.xml')
    expect(sheet).toContain('s="13"')
    expect(sheet).toContain('s="14"')
    expect(sheet).toContain('s="15"')
    expect(sheet).toContain('<v>12345.67</v>')
    expect(sheet).toContain('<v>46307</v>')
    expect(zip.readAsText('xl/styles.xml')).toContain('yyyy-mm-dd')
    expect(() =>
      createXlsxBuffer({ sheets: [{ rows: [[{ value: '￥12.00', style: 'currency' }]] }] }, [], 'Test', true)
    ).toThrow(/requires numeric/)
    expect(() => createXlsxBuffer({ sheets: [{ rows: [[{ value: -1, style: 'date' }]] }] }, [], 'Test', true)).toThrow(
      /Excel date serial/
    )
  })

  it('does not silently drop requested excess charts', () => {
    expect(() =>
      createXlsxBuffer({ sheets: [{ rows: [[1]], charts: Array.from({ length: 5 }, () => ({})) }] }, [], 'Test', true)
    ).toThrow(/at most 4 charts/)
  })

  it.each([false, true])(
    'keeps repeating Word headers and lets body rows paginate only in new mode (%s)',
    async (productQuality) => {
      const buffer = await createDocxBuffer(
        'Report',
        '| Item | Detail |\n| --- | --- |\n| A | ' + 'Long content '.repeat(400) + ' |',
        [
          ['Item', 'Detail'],
          ['B', 'Long content '.repeat(400)]
        ],
        new Map(),
        undefined,
        productQuality
      )
      const zip = new AdmZip(buffer)
      const xml = zip.readAsText('word/document.xml')
      const rows = [...xml.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)].map((match) => match[0])
      expect(rows).toHaveLength(4)
      for (const [index, row] of rows.entries()) {
        if (index % 2 === 0) expect(row).toContain('w:tblHeader')
        if (productQuality && index % 2 === 1) expect(row).toMatch(/<w:cantSplit w:val="(?:false|0)"\/>/)
        else expect(row).toContain('<w:cantSplit/>')
      }
      expect(zip.readAsText('word/styles.xml').includes('w:widowControl')).toBe(productQuality)
    }
  )

  it('checks visible PPT slide bodies, allowing split fields but excluding notes and attributes', () => {
    const zip = new AdmZip()
    zip.addFile(
      'ppt/slides/slide1.xml',
      Buffer.from('<p:sld><a:t>收入</a:t><a:t>120 &amp; 130</a:t><a:t>渠道一</a:t><a:t>稳步增长</a:t></p:sld>')
    )
    zip.addFile('ppt/notesSlides/notesSlide1.xml', Buffer.from('<a:t>未显示内容</a:t>'))
    expect(() =>
      validatePptxVisibleContent(zip.toBuffer(), [
        { title: '收入', bullets: ['渠道一: 稳步增长', '120 & 130'], notes: '未显示内容' } as any
      ])
    ).not.toThrow()
    expect(() => validatePptxVisibleContent(zip.toBuffer(), [{ title: '收入', bullets: ['未显示内容'] }])).toThrow(
      /visible content missing/
    )
    expect(() =>
      validatePptxVisibleContent(zip.toBuffer(), [
        { title: '收入', bullets: [] },
        { title: '下一页', bullets: [] }
      ])
    ).toThrow(/body is missing/)
  })
})
