import type * as NodePath from 'node:path'

import type { StructuredFileSection } from '@types'

export type OfficeZip = {
  getEntry(name: string): { getData(): { toString(encoding: 'utf8'): string } } | null
  getEntries(): Array<{ entryName: string; getData(): { toString(encoding: 'utf8'): string } }>
}

/** Existing FileStorage XML readers, shared by stored files and isolated MCP reads.
 * Keep all runtime helpers inside this factory: its compiled function is also
 * executed in the worker, so it needs no application/bundler module imports.
 */
export function createStructuredOfficeReaders(path: Pick<typeof NodePath, 'posix'>) {
  const decodeXmlText = (value: string): string =>
    value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))

  const extractXmlTagText = (xml: string, tag: string): string[] =>
    Array.from(xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g'))).map((match) =>
      decodeXmlText(match[1].replace(/<[^>]+>/g, '')).trim()
    )

  const getZipEntryText = (zip: OfficeZip, entryName: string): string =>
    zip.getEntry(entryName)?.getData().toString('utf8') ?? ''

  const parseXmlAttributes = (value: string): Record<string, string> =>
    Object.fromEntries(
      Array.from(value.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)).map((match) => [
        match[1],
        decodeXmlText(match[2] ?? match[3] ?? '')
      ])
    )

  const numericSuffix = (value: string): number => Number(value.match(/(\d+)(?:\.[^.]+)?$/)?.[1] ?? 0)

  const columnNameToNumber = (value: string): number =>
    value
      .toUpperCase()
      .split('')
      .reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0)

  const numberToColumnName = (value: number): string => {
    let current = Math.max(1, value)
    let result = ''
    while (current > 0) {
      current -= 1
      result = String.fromCharCode(65 + (current % 26)) + result
      current = Math.floor(current / 26)
    }
    return result
  }

  const parseCellReference = (reference: string): { column: number; row: number } => {
    const match = reference.match(/^([A-Z]+)(\d+)$/i)
    return {
      column: match ? columnNameToNumber(match[1]) : 1,
      row: match ? Number(match[2]) : 1
    }
  }

  const readStructuredDocx = (zip: OfficeZip): StructuredFileSection[] => {
    const documentXml = getZipEntryText(zip, 'word/document.xml')
    if (!documentXml) return []

    const sections: StructuredFileSection[] = []
    let page = 1
    let currentSection = ''
    let currentText: string[] = []

    const flush = () => {
      const text = currentText.join('\n').trim()
      if (text) {
        sections.push({
          text,
          metadata: {
            page,
            ...(currentSection ? { section: currentSection } : {})
          }
        })
      }
      currentText = []
    }

    const blocks = documentXml.match(/<w:(p|tbl)(?:\s[^>]*)?>[\s\S]*?<\/w:\1>/g) ?? []
    let table = 0
    for (const block of blocks) {
      if (block.startsWith('<w:tbl')) {
        flush()
        table += 1
        const rows = (block.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g) ?? [])
          .map((row) =>
            (row.match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g) ?? [])
              .map((cell) => extractXmlTagText(cell, 'w:t').join(''))
              .filter(Boolean)
              .join(' | ')
          )
          .filter(Boolean)
        if (rows.length > 0) {
          sections.push({
            text: rows.join('\n'),
            metadata: { page, table, ...(currentSection ? { section: currentSection } : {}) }
          })
        }
        continue
      }

      const paragraphText = extractXmlTagText(block, 'w:t').join('')
      const style = block.match(/<w:pStyle[^>]*w:val="([^"]+)"/)?.[1] ?? ''
      if (/heading|title|标题/i.test(style) && paragraphText) {
        flush()
        currentSection = paragraphText
      }
      if (paragraphText) {
        currentText.push(paragraphText)
      }
      if (/<w:(?:br\b[^>]*w:type="page"|lastRenderedPageBreak\b)/i.test(block)) {
        flush()
        page += 1
      }
    }
    flush()
    return sections
  }

  const readStructuredPptx = (zip: OfficeZip): StructuredFileSection[] => {
    const slideSections = zip
      .getEntries()
      .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName))
      .sort((left, right) => numericSuffix(left.entryName) - numericSuffix(right.entryName))
      .map((entry, index) => {
        const text = extractXmlTagText(entry.getData().toString('utf8'), 'a:t').filter(Boolean)
        const slideNumber = numericSuffix(entry.entryName)
        const notes = getZipEntryText(zip, `ppt/notesSlides/notesSlide${slideNumber}.xml`)
        const notesText = extractXmlTagText(notes, 'a:t').filter(Boolean)
        const mediaEntries = zip
          .getEntries()
          .filter((mediaEntry) => /^ppt\/media\//i.test(mediaEntry.entryName))
          .map((mediaEntry) => path.posix.basename(mediaEntry.entryName))
        return {
          text: [
            ...text,
            ...(notesText.length > 0 ? [`[备注]\n${notesText.join('\n')}`] : []),
            ...(mediaEntries.length > 0 ? [`[嵌入图片/媒体]\n${mediaEntries.join(', ')}`] : [])
          ].join('\n'),
          metadata: {
            slide: index + 1,
            ...(text[0] ? { section: text[0] } : {})
          }
        }
      })
      .filter((section) => section.text.trim())

    const chartSections = zip
      .getEntries()
      .filter((entry) => /^ppt\/charts\/chart\d+\.xml$/i.test(entry.entryName))
      .map((entry) => {
        const xml = entry.getData().toString('utf8')
        const titles = extractXmlTagText(xml, 'c:t').filter(Boolean)
        const formulas = extractXmlTagText(xml, 'c:f').filter(Boolean)
        const values = extractXmlTagText(xml, 'c:v').filter(Boolean)
        return {
          text: [
            `图表：${path.posix.basename(entry.entryName)}`,
            ...(titles.length > 0 ? [`标题：${titles.join(' / ')}`] : []),
            ...(formulas.length > 0 ? [`数据范围：${formulas.join('；')}`] : []),
            ...(values.length > 0 ? [`缓存数据：${values.join('、')}`] : [])
          ].join('\n'),
          metadata: { section: 'chart' }
        }
      })
      .filter((section) => section.text.trim())

    return [...slideSections, ...chartSections]
  }

  const readStructuredXlsxXml = (zip: OfficeZip): StructuredFileSection[] => {
    const sharedStringsXml = getZipEntryText(zip, 'xl/sharedStrings.xml')
    const sharedStrings = (sharedStringsXml.match(/<si(?:\s[^>]*)?>[\s\S]*?<\/si>/g) ?? []).map((item) =>
      extractXmlTagText(item, 't').join('')
    )
    const workbookXml = getZipEntryText(zip, 'xl/workbook.xml')
    const workbookRels = getZipEntryText(zip, 'xl/_rels/workbook.xml.rels')
    const relationTargets = new Map(
      Array.from(workbookRels.matchAll(/<Relationship\b([^>]*)\/?>/g))
        .map((match) => parseXmlAttributes(match[1]))
        .filter((attributes) => attributes.Id && attributes.Target)
        .map((attributes) => [attributes.Id, attributes.Target])
    )
    const sheets = Array.from(workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g))
      .map((match) => parseXmlAttributes(match[1]))
      .filter((attributes) => attributes.name)
      .map((attributes, index) => ({
        name: attributes.name,
        relationId: attributes['r:id'] ?? attributes.id ?? '',
        fallbackTarget: `worksheets/sheet${index + 1}.xml`
      }))
    const sections: StructuredFileSection[] = []

    for (const sheet of sheets) {
      const target = relationTargets.get(sheet.relationId) ?? sheet.fallbackTarget
      const normalizedTarget = target.startsWith('/xl/')
        ? target.slice(1)
        : target.startsWith('xl/')
          ? target
          : path.posix.normalize(path.posix.join('xl', target))
      const sheetXml = getZipEntryText(zip, normalizedTarget)
      if (!sheetXml) continue

      const rows = new Map<number, Array<{ reference: string; column: number; value: string }>>()
      for (const match of sheetXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attributes = match[1]
        const body = match[2]
        const reference = attributes.match(/\br="([^"]+)"/)?.[1] ?? 'A1'
        const type = attributes.match(/\bt="([^"]+)"/)?.[1] ?? ''
        const formula = extractXmlTagText(body, 'f')[0]
        const rawValue = extractXmlTagText(body, type === 'inlineStr' ? 't' : 'v')[0] ?? ''
        const value = type === 's' ? (sharedStrings[Number(rawValue)] ?? rawValue) : rawValue
        const displayValue = formula ? `=${formula}${value ? ` -> ${value}` : ''}` : value
        if (!displayValue) continue
        const position = parseCellReference(reference)
        const cells = rows.get(position.row) ?? []
        cells.push({ reference, column: position.column, value: displayValue })
        rows.set(position.row, cells)
      }

      const sortedRows = [...rows.entries()].sort(([left], [right]) => left - right)
      let table = 0
      let tableRows: typeof sortedRows = []
      let previousRow = -2

      const flushTable = () => {
        if (tableRows.length === 0) return
        table += 1
        for (let offset = 0; offset < tableRows.length; offset += 100) {
          const batch = tableRows.slice(offset, offset + 100)
          const firstRow = batch[0][0]
          const lastRow = batch.at(-1)?.[0] ?? firstRow
          let maxColumn = 1
          for (const [, cells] of batch) {
            for (const cell of cells) maxColumn = Math.max(maxColumn, cell.column)
          }
          sections.push({
            text: batch
              .map(([, cells]) =>
                cells
                  .sort((left, right) => left.column - right.column)
                  .map((cell) => `${cell.reference}: ${cell.value}`)
                  .join(' | ')
              )
              .join('\n'),
            metadata: {
              sheet: sheet.name,
              table,
              cellRange: `A${firstRow}:${numberToColumnName(maxColumn)}${lastRow}`
            }
          })
        }
        tableRows = []
      }

      for (const row of sortedRows) {
        if (tableRows.length > 0 && row[0] - previousRow > 1) {
          flushTable()
        }
        tableRows.push(row)
        previousRow = row[0]
      }
      flushTable()
    }

    return sections
  }

  return { docx: readStructuredDocx, pptx: readStructuredPptx, xlsx: readStructuredXlsxXml }
}
