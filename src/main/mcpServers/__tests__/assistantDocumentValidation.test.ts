import AdmZip from 'adm-zip'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { render } = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('../assistantOfficeRender', () => ({ renderOfficeBufferToPdf: render }))

import { createDocxBuffer } from '../assistantDocx'
import { verifyGeneratedOutput } from '../assistantOutputValidation'

async function renderedPdf(pages: number) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let index = 0; index < pages; index++) {
    const page = pdf.addPage()
    page.drawText(`Project execution plan page ${index + 1}`, { x: 50, y: 750, size: 18, font })
    page.drawText('Confirmed budget 8000. Previous budget 6500 is obsolete.', { x: 50, y: 700, size: 12, font })
  }
  return Buffer.from(await pdf.save())
}

beforeEach(() => render.mockReset())

describe('DOCX physical page requirements', () => {
  it('requires actual rendering and accepts the rendered physical page count', async () => {
    render.mockResolvedValue({ status: 'rendered', renderer: 'microsoft-office', pdf: await renderedPdf(2) })
    const buffer = await createDocxBuffer('项目方案', '执行内容', [])
    const result = await verifyGeneratedOutput({ format: 'docx', buffer, expectedPages: 2 })
    expect(render).toHaveBeenCalledWith('docx', buffer, 'required')
    expect(result.checks).toContain('docx-exact-page-count')
    expect(result.details.rendered_page_count).toBe(2)
    expect(result.details.render_verification).toBe('passed')
  })

  it('rejects three rendered pages even when the DOCX cached properties claim two', async () => {
    render.mockResolvedValue({ status: 'rendered', pdf: await renderedPdf(3) })
    const zip = new AdmZip(await createDocxBuffer('两页方案', '执行内容', []))
    zip.updateFile(
      'docProps/app.xml',
      Buffer.from(
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>2</Pages></Properties>'
      )
    )
    const buffer = zip.toBuffer()
    await expect(verifyGeneratedOutput({ format: 'docx', buffer, expectedPages: 2 })).rejects.toThrow(
      /page count mismatch: expected 2, received 3/
    )
  })

  it('does not claim an exact page count when rendering is unavailable or skipped', async () => {
    const buffer = await createDocxBuffer('两页方案', '执行内容', [])
    render.mockResolvedValue({ status: 'unavailable', reason: 'No installed Office renderer' })
    await expect(verifyGeneratedOutput({ format: 'docx', buffer, expectedPages: 2 })).rejects.toThrow(
      /render verification is unavailable/
    )
    render.mockClear()
    await expect(
      verifyGeneratedOutput({ format: 'docx', buffer, expectedPages: 2, renderValidation: 'skip' })
    ).rejects.toThrow(/require rendering/)
    expect(render).not.toHaveBeenCalled()
  })
})
