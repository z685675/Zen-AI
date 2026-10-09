import * as XLSX from '@e965/xlsx'
import type { StructuredFileSection } from '@types'

export class SpreadsheetExtractionLimitError extends Error {}

const MAX_CELLS = 100_000
const MAX_CHARACTERS = 2_000_000

/** Never expand !ref: a tiny workbook may mark the entire Excel grid as used. */
export function spreadsheetSections(workbook: XLSX.WorkBook, embeddedMedia: string[]): StructuredFileSection[] {
  const sections: StructuredFileSection[] = []
  let cellCount = 0
  let characters = 0
  const account = (length: number) => {
    characters += length
    if (characters > MAX_CHARACTERS) {
      throw new SpreadsheetExtractionLimitError('表格提取内容过多，请按工作表或数据范围分批读取原文件。')
    }
  }

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue
    const rows = new Map<number, Map<number, string>>()
    for (const address of Object.keys(sheet)) {
      if (!/^[A-Z]+[1-9]\d*$/.test(address)) continue
      const cell = sheet[address] as XLSX.CellObject | undefined
      if (!cell || ((cell.v === undefined || cell.v === '') && !cell.f)) continue
      if (++cellCount > MAX_CELLS) {
        throw new SpreadsheetExtractionLimitError('表格有效单元格过多，请按工作表或数据范围分批读取原文件。')
      }
      const { r, c } = XLSX.utils.decode_cell(address)
      const formatted = cell.w ?? (cell.v instanceof Date ? cell.v.toISOString() : String(cell.v ?? ''))
      const value = cell.f
        ? formatted && formatted !== cell.f
          ? `=${cell.f} [结果: ${formatted}]`
          : `=${cell.f}`
        : formatted
      account(value.length + address.length)
      const row = rows.get(r) ?? new Map<number, string>()
      row.set(c, value)
      rows.set(r, row)
    }

    const sortedRows = [...rows.entries()].sort(([left], [right]) => left - right)
    const escape = (value: string) => value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
    let table = 0
    for (let offset = 0; offset < sortedRows.length; offset += 80) {
      const batch = sortedRows.slice(offset, offset + 80)
      let firstColumn = Infinity
      let lastColumn = 0
      for (const [, cells] of batch) {
        for (const column of cells.keys()) {
          firstColumn = Math.min(firstColumn, column)
          lastColumn = Math.max(lastColumn, column)
        }
      }
      const cellRange = XLSX.utils.encode_range({
        s: { r: batch[0][0], c: firstColumn },
        e: { r: batch[batch.length - 1][0], c: lastColumn }
      })
      const lines = [`工作表：${sheetName}`, `单元格范围：${cellRange}`, '仅列出有内容的行，行号与原文件一致。']
      if (lastColumn - firstColumn < 128) {
        const columns = Array.from({ length: lastColumn - firstColumn + 1 }, (_, index) => firstColumn + index)
        lines.push('| 行号 | ' + columns.map(XLSX.utils.encode_col).join(' | ') + ' |')
        lines.push('| --- | ' + columns.map(() => '---').join(' | ') + ' |')
        for (const [row, cells] of batch) {
          lines.push(`| ${row + 1} | ${columns.map((column) => escape(cells.get(column) ?? '')).join(' | ')} |`)
        }
      } else {
        // Widely separated columns are represented by their exact addresses.
        for (const [row, cells] of batch) {
          lines.push(
            [...cells.entries()]
              .sort(([left], [right]) => left - right)
              .map(([column, value]) => `${XLSX.utils.encode_cell({ r: row, c: column })}: ${escape(value)}`)
              .join(' | ')
          )
        }
      }
      if (offset === 0) {
        const merges = (sheet['!merges'] ?? []).map((merge) => XLSX.utils.encode_range(merge)).join(', ')
        if (merges) lines.push(`合并单元格：${merges}`)
        if (embeddedMedia.length) lines.push(`嵌入图片/媒体：${embeddedMedia.join(', ')}`)
      }
      const text = lines.join('\n')
      account(text.length)
      sections.push({ text, metadata: { sheet: sheetName, table: ++table, cellRange } })
    }
  }
  return sections
}
