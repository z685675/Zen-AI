import { approximateTokenSize } from 'tokenx'
import { describe, expect, it } from 'vitest'

import {
  checkpointAttachmentCoverage,
  escapeContextAttribute,
  fitCheckpointAttachments,
  missingCheckpointAttachmentNames,
  missingCheckpointAttachments,
  readCheckpointAttachments,
  splitAttachmentCheckpointChunks
} from '../ContextAttachmentExcerptService'

const document = (index: number, repeats = 300) => `<file name="${index} 联合实验室任务书.pdf">
<part page="1">
项目编号：实验室${index}；承担单位：单位${index}。
</part>
<part page="2">
${'申请流程、财务要求与一般管理规定。'.repeat(repeats)}
</part>
<part page="8">
研究内容：实验${index}的特定研究；目标：指标${index}；成果：产出${index}。
</part>
<part page="20">
${'附件签章与附录一般条款。'.repeat(repeats)}
</part>
</file>`

const workbook = `<file name="联合实验室领域分类建议（基于研究内容）.xlsx">
<part sheet="分类规则" range="A1:C4">
前沿技术：机理研究；应用技术：产品与工艺；民生科技：公共需求。
</part>
</file>`

describe('attachment-aware context fitting', () => {
  it('retains task evidence and locators for 13 PDFs and the reference workbook, including middle attachments', () => {
    const order = [7, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13]
    const source = `请按研究内容、目标、成果分类所有项目。\n${order.map((index) => document(index)).join('\n')}\n${workbook}`
    expect(approximateTokenSize(source)).toBeGreaterThan(18_000)
    const result = fitCheckpointAttachments(source, 12_000, '研究内容、目标、成果')!
    expect(approximateTokenSize(result.text)).toBeLessThanOrEqual(12_000)
    expect(result.coverage).toHaveLength(14)
    expect(result.coverage.every((file) => file.mode === 'full' || file.mode === 'excerpt')).toBe(true)
    expect(readCheckpointAttachments(result.text).map((file) => file.name)).toEqual([
      ...order.map((index) => `${index} 联合实验室任务书.pdf`),
      '联合实验室领域分类建议（基于研究内容）.xlsx'
    ])
    for (const index of order) {
      expect(result.text).toContain(`实验${index}的特定研究`)
      expect(result.text).toContain(`指标${index}`)
      expect(result.text).toContain(`产出${index}`)
    }
    expect(result.text).toContain('page="8"')
    expect(result.text).toContain('sheet="分类规则" range="A1:C4"')
    expect(result.text).toContain('不等于全文')
  })

  it('gives unused small-file allowance to larger files and reports actual selection counts', () => {
    const source = `${workbook}\n${document(5, 500)}`
    const result = fitCheckpointAttachments(source, 4_000, '研究内容')!
    expect(result.coverage[0].mode).toBe('full')
    expect(result.coverage[1].mode).toBe('excerpt')
    expect(result.coverage[1].selectedParts).toBeLessThan(result.coverage[1].totalParts)
    expect(checkpointAttachmentCoverage(result.text, source)).toEqual(result.coverage)
    expect(approximateTokenSize(result.text)).toBeLessThanOrEqual(4_000)
    const refitted = fitCheckpointAttachments(result.text, 3_800, '研究内容')!
    expect(refitted.coverage[1].mode).toBe('excerpt')
    expect(refitted.coverage[1].totalParts).toBe(result.coverage[1].totalParts)
  })

  it('retains an honest file inventory even when only metadata fits', () => {
    const source = Array.from({ length: 13 }, (_, index) => document(index + 1)).join('\n')
    const result = fitCheckpointAttachments(source, 1_700, '研究内容')!
    expect(result).toBeDefined()
    expect(missingCheckpointAttachments(source, result.text)).toEqual([])
    expect(result.coverage.some((file) => file.mode === 'metadata-only')).toBe(true)
    expect(approximateTokenSize(result.text)).toBeLessThanOrEqual(1_700)
  })

  it('checks all Chinese filenames beyond the generic 24-anchor sample', () => {
    const source = Array.from({ length: 35 }, (_, index) => document(index, 1)).join('\n')
    const names = readCheckpointAttachments(source).map((file) => file.name)
    expect(missingCheckpointAttachments(source, names.slice(0, 34).join('\n'))).toEqual([names[34]])
    expect(checkpointAttachmentCoverage(names.join('\n'), source).every((file) => file.mode === 'summary')).toBe(true)
    expect(missingCheckpointAttachmentNames(['1 项目.pdf', '11 项目.pdf'], '仅记得11 项目.pdf。')).toEqual([
      '1 项目.pdf'
    ])
  })

  it('does not report an empty extracted file as fully read', () => {
    const result = fitCheckpointAttachments('<file name="扫描件.pdf">\n\n</file>', 1_000)!
    expect(result.coverage[0]).toMatchObject({ mode: 'metadata-only', totalParts: 0 })
  })

  it('retains extraction failures without presenting the error marker as document evidence', () => {
    const source = '<file name="损坏文件.pdf" extraction="failed">\n[提取失败]\n</file>'
    const result = fitCheckpointAttachments(source, 1_000)!
    expect(result.coverage[0]).toMatchObject({ mode: 'unavailable', selectedParts: 0 })
    expect(checkpointAttachmentCoverage(result.text, source)[0].mode).toBe('unavailable')
    expect(result.text).toContain('本次内容提取失败')
  })

  it('preserves quoted and ampersand filenames when checking source associations', () => {
    const name = '研究"甲"&乙.pdf'
    const source = `<file name="${escapeContextAttribute(name)}">\n<part page="3">\n研究内容：可靠原文。\n</part>\n</file>`
    const result = fitCheckpointAttachments(source, 1_000)!
    expect(readCheckpointAttachments(result.text)[0].name).toBe(name)
    expect(missingCheckpointAttachments(source, result.text)).toEqual([])
  })

  it('leaves ordinary conversation text on the existing compaction path', () => {
    expect(fitCheckpointAttachments('ordinary conversation', 100)).toBeUndefined()
  })

  it('does not turn a truncated amount into a different numeric value', () => {
    const source = `<file name="预算.pdf">\n<part page="1">\n${'费用：金额7319元。'.repeat(500)}\n</part>\n</file>`
    for (const limit of [700, 950, 1_200]) {
      const result = fitCheckpointAttachments(source, limit, '费用')!
      const amounts = [...result.text.matchAll(/金额(\d+)/g)].map((match) => match[1])
      expect(amounts.length).toBeGreaterThan(0)
      expect(amounts.every((amount) => amount === '7319')).toBe(true)
    }
  })

  it('keeps all file text and page associations across bounded remote-summary chunks', () => {
    const source = `${workbook}\n${document(6, 300)}`
    const split = (text: string, maxTokens: number): string[] => {
      expect(approximateTokenSize(text)).toBeLessThanOrEqual(maxTokens)
      return [text]
    }
    const chunks = splitAttachmentCheckpointChunks(source, 4_000, split)!
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => approximateTokenSize(chunk) <= 4_000)).toBe(true)
    const recovered = chunks.flatMap(readCheckpointAttachments).filter((file) => file.name === '6 联合实验室任务书.pdf')
    expect(recovered.length).toBeGreaterThan(1)
    const text = recovered.map((file) => file.body).join('\n')
    expect(text).toContain('实验6的特定研究')
    expect(text).toContain('page="8"')
    expect(text.match(/一般管理规定/g)?.length).toBe(300)
    expect(text.match(/一般条款/g)?.length).toBe(300)
  })
})
