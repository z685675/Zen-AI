import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  type ParagraphChild,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType
} from 'docx'
import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

import { fitImageWithin, type LoadedImageAsset } from './assistantAssets'
import { defaultDocumentStyle, type ResolvedDocumentStyle } from './assistantDocumentStyles'

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false })
const NUMBERING_REFERENCE = 'zen-ai-decimal-list'

interface ListState {
  type: 'bullet' | 'ordered'
  level: number
  instance: number
}

interface InlineStyleState {
  bold: number
  italics: number
  strike: number
}

function createDocumentParagraphStyles(style: ResolvedDocumentStyle) {
  const headingFont = {
    ascii: style.headingFont,
    hAnsi: style.headingFont,
    eastAsia: style.eastAsiaFont
  }
  const headings = [
    { level: 1, size: 34, color: style.primary, before: 260, after: 120 },
    { level: 2, size: 29, color: style.secondary, before: 220, after: 100 },
    { level: 3, size: 25, color: style.deep, before: 180, after: 80 },
    { level: 4, size: 23, color: style.ink, before: 160, after: 70 },
    { level: 5, size: 22, color: style.ink, before: 140, after: 60 },
    { level: 6, size: 21, color: style.muted, before: 120, after: 60 }
  ]

  return [
    {
      id: 'ZenAiDocumentTitle',
      name: 'Zen AI Document Title',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { size: 44, bold: true, color: style.primary, font: headingFont },
      paragraph: { spacing: { before: 100, after: 240 }, keepNext: true }
    },
    ...headings.map((heading) => ({
      id: `Heading${heading.level}`,
      name: `Heading ${heading.level}`,
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { size: heading.size, bold: true, color: heading.color, font: headingFont },
      paragraph: {
        spacing: { before: heading.before, after: heading.after },
        keepNext: true,
        outlineLevel: heading.level - 1
      }
    })),
    {
      id: 'ZenAiTableHeader',
      name: 'Zen AI Table Header',
      basedOn: 'Normal',
      run: { bold: true, color: style.onPrimary },
      paragraph: { spacing: { after: 0, line: 300 } }
    }
  ]
}

export async function createDocxBuffer(
  title: string,
  content: string,
  rows: string[][],
  assets: Map<string, LoadedImageAsset> = new Map(),
  style?: ResolvedDocumentStyle
): Promise<Buffer> {
  const documentStyle = style ?? defaultDocumentStyle('docx')
  const displayTitle = title.replace(/\.docx$/i, '').trim() || 'Document'
  const tokens = markdown.parse(content || '', {})
  const children = renderMarkdownBlocks(tokens, displayTitle, assets, documentStyle)

  if (rows.length > 0) {
    children.push(createDataTable(rows, documentStyle))
  }

  const document = new Document({
    title: displayTitle,
    subject: 'Generated document',
    creator: 'Zen AI',
    lastModifiedBy: 'Zen AI',
    styles: {
      default: {
        document: {
          run: {
            font: {
              ascii: documentStyle.bodyFont,
              hAnsi: documentStyle.bodyFont,
              eastAsia: documentStyle.eastAsiaFont
            },
            size: 22,
            color: documentStyle.ink,
            language: { value: 'en-US', eastAsia: 'zh-CN' }
          },
          paragraph: {
            spacing: { line: 340, after: 120 }
          }
        }
      },
      paragraphStyles: createDocumentParagraphStyles(documentStyle)
    },
    numbering: {
      config: [
        {
          reference: NUMBERING_REFERENCE,
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: {
              paragraph: {
                indent: { left: 720 + level * 360, hanging: 360 }
              }
            }
          }))
        }
      ]
    },
    sections: [{ properties: {}, children }]
  })

  return Buffer.from(await Packer.toBuffer(document))
}

function renderMarkdownBlocks(
  tokens: Token[],
  title: string,
  assets: Map<string, LoadedImageAsset>,
  style: ResolvedDocumentStyle
): Array<Paragraph | Table> {
  const blocks: Array<Paragraph | Table> = []
  const listStack: ListState[] = []
  let orderedListInstance = 0
  let blockquoteDepth = 0

  const leadingHeading = tokens[0]?.type === 'heading_open' && tokens[0]?.tag === 'h1' ? tokens[1] : undefined
  const contentProvidesTitle =
    leadingHeading?.type === 'inline' && normalizeTitle(leadingHeading.content) === normalizeTitle(title)

  if (!contentProvidesTitle) {
    blocks.push(createHeadingParagraph([new TextRun({ text: title })], 1, style, true))
  }

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]

    switch (token.type) {
      case 'heading_open': {
        const level = Math.min(6, Math.max(1, Number(token.tag.slice(1)) || 1))
        const inline = tokens[index + 1]
        blocks.push(
          createHeadingParagraph(renderInline(inline, assets, style), level, style, index === 0 && level === 1)
        )
        index += 2
        break
      }
      case 'paragraph_open': {
        const inline = tokens[index + 1]
        blocks.push(createBodyParagraph(renderInline(inline, assets, style), listStack.at(-1), blockquoteDepth, style))
        index += 2
        break
      }
      case 'bullet_list_open':
        listStack.push({ type: 'bullet', level: listStack.length, instance: 0 })
        break
      case 'bullet_list_close':
        listStack.pop()
        break
      case 'ordered_list_open':
        orderedListInstance += 1
        listStack.push({ type: 'ordered', level: listStack.length, instance: orderedListInstance })
        break
      case 'ordered_list_close':
        listStack.pop()
        break
      case 'blockquote_open':
        blockquoteDepth += 1
        break
      case 'blockquote_close':
        blockquoteDepth = Math.max(0, blockquoteDepth - 1)
        break
      case 'table_open': {
        const table = parseMarkdownTable(tokens, index, assets, style)
        blocks.push(table.value)
        index = table.endIndex
        break
      }
      case 'fence':
      case 'code_block':
        blocks.push(createCodeParagraph(token.content, style))
        break
      case 'hr':
        blocks.push(createHorizontalRule(style))
        break
    }
  }

  if (blocks.length === 0) {
    blocks.push(createHeadingParagraph([new TextRun({ text: title })], 1, style, true))
  }

  return blocks
}

function createHeadingParagraph(
  children: ParagraphChild[],
  level: number,
  style: ResolvedDocumentStyle,
  documentTitle = false
): Paragraph {
  const editorial = style.variant === 'editorial'
  return new Paragraph({
    children: children.length > 0 ? children : [new TextRun('')],
    style: documentTitle ? 'ZenAiDocumentTitle' : undefined,
    heading: documentTitle ? undefined : headingLevel(level),
    keepNext: true,
    border:
      documentTitle || (editorial && level <= 2)
        ? { bottom: { style: BorderStyle.SINGLE, size: documentTitle ? 14 : 6, color: style.primary, space: 8 } }
        : undefined,
    spacing: { before: documentTitle ? 100 : level === 1 ? 240 : 200, after: documentTitle ? 240 : 100 }
  })
}

function createBodyParagraph(
  children: ParagraphChild[],
  list: ListState | undefined,
  quoteDepth: number,
  style: ResolvedDocumentStyle
): Paragraph {
  const listProperties = list
    ? list.type === 'bullet'
      ? { style: 'ListParagraph', bullet: { level: Math.min(8, list.level) } }
      : {
          style: 'ListParagraph',
          numbering: {
            reference: NUMBERING_REFERENCE,
            level: Math.min(8, list.level),
            instance: list.instance
          }
        }
    : {}

  return new Paragraph({
    children: children.length > 0 ? children : [new TextRun('')],
    ...listProperties,
    indent: quoteDepth > 0 ? { left: 360 * quoteDepth } : undefined,
    border:
      quoteDepth > 0 ? { left: { style: BorderStyle.SINGLE, size: 12, color: style.accent, space: 8 } } : undefined,
    shading: quoteDepth > 0 ? { type: ShadingType.CLEAR, fill: style.soft, color: 'auto' } : undefined,
    spacing: { after: 120, line: 340 }
  })
}

function renderInline(
  inline: Token | undefined,
  assets: Map<string, LoadedImageAsset>,
  documentStyle: ResolvedDocumentStyle,
  forceBold = false
): ParagraphChild[] {
  const tokens = inline?.children || []
  const result: ParagraphChild[] = []
  const style: InlineStyleState = { bold: 0, italics: 0, strike: 0 }
  let link: { target: string; runs: TextRun[] } | undefined

  const addRun = (text: string, options: { code?: boolean; break?: number } = {}) => {
    const run = new TextRun({
      text,
      break: options.break,
      bold: forceBold || style.bold > 0,
      italics: style.italics > 0,
      strike: style.strike > 0,
      font: options.code ? 'Consolas' : undefined,
      color: options.code ? documentStyle.deep : undefined,
      shading: options.code ? { type: ShadingType.CLEAR, fill: documentStyle.soft, color: 'auto' } : undefined
    })
    if (link) link.runs.push(run)
    else result.push(run)
  }

  for (const token of tokens) {
    switch (token.type) {
      case 'strong_open':
        style.bold += 1
        break
      case 'strong_close':
        style.bold = Math.max(0, style.bold - 1)
        break
      case 'em_open':
        style.italics += 1
        break
      case 'em_close':
        style.italics = Math.max(0, style.italics - 1)
        break
      case 's_open':
        style.strike += 1
        break
      case 's_close':
        style.strike = Math.max(0, style.strike - 1)
        break
      case 'link_open':
        link = { target: token.attrGet('href') || '', runs: [] }
        break
      case 'link_close':
        if (link?.target) {
          result.push(
            new ExternalHyperlink({
              link: link.target,
              children: link.runs.length > 0 ? link.runs : [new TextRun({ text: link.target, style: 'Hyperlink' })]
            })
          )
        } else if (link) {
          result.push(...link.runs)
        }
        link = undefined
        break
      case 'text':
        addRun(token.content)
        break
      case 'code_inline':
        addRun(token.content, { code: true })
        break
      case 'softbreak':
        addRun(' ')
        break
      case 'hardbreak':
        addRun('', { break: 1 })
        break
      case 'image': {
        const source = token.attrGet('src') || ''
        const assetId = source.startsWith('asset:') ? source.slice('asset:'.length) : ''
        const asset = assetId ? assets.get(assetId) : undefined
        if (!asset) {
          addRun(`[Image: ${token.content || source}]`)
          break
        }
        const transformation = fitImageWithin(asset, 600, 420)
        result.push(
          new ImageRun({
            type: 'png',
            data: asset.data,
            transformation,
            altText: {
              title: token.content || asset.altText,
              description: token.content || asset.altText,
              name: asset.id
            }
          })
        )
        break
      }
    }
  }

  if (link) result.push(...link.runs)
  return result
}

function parseMarkdownTable(
  tokens: Token[],
  startIndex: number,
  assets: Map<string, LoadedImageAsset>,
  style: ResolvedDocumentStyle
): { value: Table; endIndex: number } {
  const rows: TableRow[] = []
  let cells: TableCell[] = []
  let headerSection = false
  let rowIsHeader = false
  let endIndex = startIndex

  for (let index = startIndex + 1; index < tokens.length; index++) {
    const token = tokens[index]
    endIndex = index

    if (token.type === 'table_close') break
    if (token.type === 'thead_open') headerSection = true
    if (token.type === 'tbody_open') headerSection = false
    if (token.type === 'tr_open') {
      cells = []
      rowIsHeader = headerSection
    }
    if (token.type === 'th_open' || token.type === 'td_open') {
      const inline = tokens[index + 1]?.type === 'inline' ? tokens[index + 1] : undefined
      cells.push(
        createTableCell(renderInline(inline, assets, style, rowIsHeader), rowIsHeader, tableCellAlignment(token), style)
      )
      index += 2
      endIndex = index
    }
    if (token.type === 'tr_close') {
      rows.push(new TableRow({ children: cells, tableHeader: rowIsHeader, cantSplit: true }))
    }
  }

  return { value: createTable(rows, style), endIndex }
}

function createDataTable(rows: string[][], style: ResolvedDocumentStyle): Table {
  const normalizedRows = rows.map((row) => (row.length > 0 ? row : ['']))
  return createTable(
    normalizedRows.map(
      (row, rowIndex) =>
        new TableRow({
          tableHeader: rowIndex === 0,
          cantSplit: true,
          children: row.map((cell) =>
            createTableCell(
              [new TextRun({ text: cell, bold: rowIndex === 0, color: rowIndex === 0 ? style.onPrimary : undefined })],
              rowIndex === 0,
              AlignmentType.LEFT,
              style
            )
          )
        })
    ),
    style
  )
}

function createTable(rows: TableRow[], style: ResolvedDocumentStyle): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: style.line },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: style.line },
      left: { style: BorderStyle.SINGLE, size: 4, color: style.line },
      right: { style: BorderStyle.SINGLE, size: 4, color: style.line },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: style.line },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: style.line }
    }
  })
}

function createTableCell(
  children: ParagraphChild[],
  header: boolean,
  alignment: string,
  style: ResolvedDocumentStyle
): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        children: children.length > 0 ? children : [new TextRun('')],
        style: header ? 'ZenAiTableHeader' : undefined,
        alignment: alignment as (typeof AlignmentType)[keyof typeof AlignmentType],
        spacing: { after: 0, line: 300 }
      })
    ],
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    shading: header ? { type: ShadingType.CLEAR, fill: style.primary, color: 'auto' } : undefined
  })
}

function createCodeParagraph(code: string, style: ResolvedDocumentStyle): Paragraph {
  const lines = code.replace(/\n$/, '').split('\n')
  return new Paragraph({
    children: lines.map(
      (line, index) =>
        new TextRun({
          text: line || ' ',
          break: index > 0 ? 1 : undefined,
          font: 'Consolas',
          size: 19,
          color: style.deep
        })
    ),
    shading: { type: ShadingType.CLEAR, fill: style.soft, color: 'auto' },
    border: {
      top: { style: BorderStyle.SINGLE, size: 2, color: style.line },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: style.line },
      left: { style: BorderStyle.SINGLE, size: 2, color: style.line },
      right: { style: BorderStyle.SINGLE, size: 2, color: style.line }
    },
    spacing: { before: 100, after: 140 }
  })
}

function createHorizontalRule(style: ResolvedDocumentStyle): Paragraph {
  return new Paragraph({
    children: [new TextRun('')],
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: style.primary, space: 8 } },
    spacing: { before: 80, after: 120 }
  })
}

function tableCellAlignment(token: Token): string {
  const style = token.attrGet('style') || ''
  if (style.includes('center')) return AlignmentType.CENTER
  if (style.includes('right')) return AlignmentType.RIGHT
  return AlignmentType.LEFT
}

function headingLevel(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (level) {
    case 1:
      return HeadingLevel.HEADING_1
    case 2:
      return HeadingLevel.HEADING_2
    case 3:
      return HeadingLevel.HEADING_3
    case 4:
      return HeadingLevel.HEADING_4
    case 5:
      return HeadingLevel.HEADING_5
    default:
      return HeadingLevel.HEADING_6
  }
}

function normalizeTitle(value: string): string {
  return value
    .replace(/\.docx$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
