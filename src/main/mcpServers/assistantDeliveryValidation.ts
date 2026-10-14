import fsp from 'node:fs/promises'
import path from 'node:path'

import AdmZip from 'adm-zip'
import { XMLParser } from 'fast-xml-parser'
import { PDFArray, PDFDocument, PDFStream } from 'pdf-lib'

import {
  type GeneratedOutputFormat,
  type GeneratedOutputVerification,
  verifyGeneratedOutput
} from './assistantOutputValidation'

const SUPPORTED_FORMATS = new Set<GeneratedOutputFormat>(['md', 'txt', 'csv', 'docx', 'xlsx', 'pptx', 'pdf'])
export const MAX_DELIVERY_VALIDATION_BYTES = 32 * 1024 * 1024
const MAX_PACKAGE_ENTRIES = 5_000
const MAX_PACKAGE_EXPANDED_BYTES = 64 * 1024 * 1024
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true })

export interface PresentedOutputVerification {
  verified: boolean
  verification_scope: 'structure-and-content' | 'structure-only' | 'existence-only'
  verification?: GeneratedOutputVerification
  warnings: string[]
}

// The caller resolves and authorizes the canonical path. This check never
// executes a file, installs a dependency, launches Office or calls a model.
export async function verifyPresentedOutput(filePath: string, size: number): Promise<PresentedOutputVerification> {
  const format = path.extname(filePath).slice(1).toLowerCase() as GeneratedOutputFormat
  if (!SUPPORTED_FORMATS.has(format)) {
    return existenceOnly('This file type has no built-in content validator; only its existence was checked.')
  }
  if (size > MAX_DELIVERY_VALIDATION_BYTES) {
    return existenceOnly('File exceeds the 32 MiB automatic validation limit; content validation was not performed.')
  }
  // Open once and cap the read as well as the stat, so a concurrently growing
  // output cannot turn presentation into an unbounded read.
  const file = await fsp.open(filePath, 'r')
  let buffer: Buffer
  try {
    const current = await file.stat()
    if (!current.isFile()) throw new Error('Final output is no longer a regular file')
    if (current.size > MAX_DELIVERY_VALIDATION_BYTES)
      return existenceOnly('File grew beyond the automatic validation limit.')
    if (current.size !== size)
      throw new Error('Final output changed before validation; finish writing it before delivery')
    const bytes = Buffer.alloc(current.size + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    const after = await file.stat()
    if (length !== current.size || after.size !== current.size || after.mtimeMs !== current.mtimeMs) {
      throw new Error('Final output changed during validation; finish writing it before delivery')
    }
    buffer = bytes.subarray(0, length)
  } finally {
    await file.close()
  }

  const office = format === 'docx' || format === 'xlsx' || format === 'pptx'
  let zip: AdmZip | undefined
  if (office) {
    zip = new AdmZip(buffer)
    const entries = zip.getEntries()
    const expanded = entries.reduce((sum, entry) => sum + entry.header.size, 0)
    if (entries.length > MAX_PACKAGE_ENTRIES || expanded > MAX_PACKAGE_EXPANDED_BYTES) {
      throw new Error(
        'Office package exceeds automatic validation safety limits; inspect it separately before delivery'
      )
    }
  }

  // Reuse format/relationship checks without adding costly rendering or a
  // hidden LLM review. Semantic feature checks remain in the applicable Skill.
  const verification = await verifyGeneratedOutput({ format, buffer, renderValidation: 'skip' })
  if (zip && format === 'docx') inspectDocument(zip, verification)
  if (zip && format === 'xlsx') inspectWorkbook(zip, verification)
  if (zip && format === 'pptx') inspectPresentation(zip, verification)
  if (format === 'pdf') await inspectPdfContent(buffer, verification)
  const incomplete = Number(verification.details.uncached_formula_cells || 0) > 0
  const scope = incomplete ? 'structure-only' : 'structure-and-content'
  verification.details.validation_scope = scope
  verification.warnings.push(
    'Content/structure checks do not verify factual accuracy, formula recalculation or visual layout.'
  )
  return { verified: !incomplete, verification_scope: scope, verification, warnings: verification.warnings }
}

function existenceOnly(warning: string): PresentedOutputVerification {
  return { verified: false, verification_scope: 'existence-only', warnings: [warning] }
}

function inspectDocument(zip: AdmZip, result: GeneratedOutputVerification) {
  const body = xmlParser.parse(zip.readAsText('word/document.xml'))?.document?.body
  let text = ''
  let objects = 0
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 't') text += textValue(child)
      else if (['drawing', 'pict', 'object', 'oMath'].includes(key)) objects++
      else visit(child)
    }
  }
  visit(body)
  if (!text.trim() && !objects) throw new Error('DOCX body has no visible text or embedded content')
  result.checks.push('docx-body-content')
  result.details.body_text_characters = text.trim().length
  result.details.body_objects = objects
}

function inspectWorkbook(zip: AdmZip, result: GeneratedOutputVerification) {
  const sheets = asArray(xmlParser.parse(zip.readAsText('xl/workbook.xml'))?.workbook?.sheets?.sheet)
  const names = sheets.map((sheet) => String(sheet['@_name'] ?? ''))
  if (!sheets.length || names.some((name) => !name.trim())) throw new Error('XLSX has no named sheets')
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length)
    throw new Error('XLSX has duplicate sheet names')
  const relationships = asArray(
    xmlParser.parse(zip.readAsText('xl/_rels/workbook.xml.rels'))?.Relationships?.Relationship
  )
  let cells = 0
  let formulas = 0
  let uncached = 0
  const strings = asArray(xmlParser.parse(zip.readAsText('xl/sharedStrings.xml') || '<sst/>')?.sst?.si)
  for (const sheet of sheets) {
    const relationship = relationships.find((item) => item['@_Id'] === sheet['@_id'])
    if (!relationship) throw new Error(`XLSX sheet '${sheet['@_name']}' has no workbook relationship`)
    if (!String(relationship['@_Type']).endsWith('/worksheet')) continue
    const target = decodeURIComponent(String(relationship['@_Target'] ?? '')).replaceAll('\\', '/')
    const part = path.posix.normalize(target.startsWith('/') ? target.slice(1) : `xl/${target}`)
    const worksheet = xmlParser.parse(zip.readAsText(part))?.worksheet
    if (!worksheet) throw new Error(`XLSX sheet '${sheet['@_name']}' has no readable worksheet`)
    for (const row of asArray(worksheet.sheetData?.row)) {
      for (const cell of asArray(row.c)) {
        if (cell.f !== undefined) {
          formulas++
          if (cell.v === undefined || cell.v === '') uncached++
        }
        if (cell['@_t'] === 'e') throw new Error(`XLSX contains an Excel error at '${sheet['@_name']}'!${cell['@_r']}`)
        if (cell['@_t'] === 's') {
          const index = Number(cell.v)
          if (!Number.isInteger(index) || index < 0 || index >= strings.length) {
            throw new Error(`XLSX cell '${sheet['@_name']}'!${cell['@_r']} references a missing shared string`)
          }
          if (textValue(strings[index]).trim()) cells++
          continue
        }
        if (cell.f !== undefined || (cell.v !== undefined && cell.v !== '') || textValue(cell.is).trim()) cells++
      }
    }
  }
  if (!cells) throw new Error('XLSX has no data or formula cells')
  result.checks.push('xlsx-sheets', 'xlsx-data', 'xlsx-formula-caches')
  result.details.sheets = sheets.length
  result.details.sheet_names = names.join(', ')
  result.details.data_cells = cells
  result.details.formula_cells = formulas
  result.details.uncached_formula_cells = uncached
  if (uncached)
    result.warnings.push(
      `${uncached} formula cell(s) have no cached result; recalculation is not verified. Follow the XLSX Skill validator before claiming correct totals.`
    )
}

function inspectPresentation(zip: AdmZip, result: GeneratedOutputVerification) {
  const slides = asArray(xmlParser.parse(zip.readAsText('ppt/presentation.xml'))?.presentation?.sldIdLst?.sldId)
  const relationships = asArray(
    xmlParser.parse(zip.readAsText('ppt/_rels/presentation.xml.rels'))?.Relationships?.Relationship
  )
  if (!slides.length) throw new Error('PPTX presentation has no linked slides')
  for (const slide of slides) {
    const relationship = relationships.find((item) => item['@_Id'] === slide['@_id'])
    if (!relationship || !String(relationship['@_Type']).endsWith('/slide')) {
      throw new Error('PPTX slide has no valid presentation relationship')
    }
    const target = decodeURIComponent(String(relationship['@_Target'] ?? '')).replaceAll('\\', '/')
    const part = path.posix.normalize(target.startsWith('/') ? target.slice(1) : `ppt/${target}`)
    const contents = xmlParser.parse(zip.readAsText(part))?.sld?.cSld
    const shapes = contents?.spTree
    if (
      !contents ||
      (!contents.bg && !['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp'].some((key) => shapes?.[key] !== undefined))
    ) {
      throw new Error(`PPTX linked slide '${part}' has no slide content`)
    }
  }
  result.checks.push('pptx-linked-slides')
  result.details.presentation_slides = slides.length
}

async function inspectPdfContent(buffer: Buffer, result: GeneratedOutputVerification) {
  const document = await PDFDocument.load(buffer)
  const pagesWithContent = document.getPages().filter((page) => {
    const contents = page.node.Contents()
    const streams =
      contents instanceof PDFArray ? contents.asArray().map((item) => document.context.lookup(item)) : [contents]
    return (
      streams.some((stream) => stream instanceof PDFStream && stream.getContentsSize() > 0) ||
      (page.node.Annots()?.size() ?? 0) > 0
    )
  }).length
  if (!pagesWithContent) throw new Error('PDF has no page content streams or annotations')
  result.checks.push('pdf-content-streams')
  result.details.pages_with_content_streams = pagesWithContent
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value]
}

function textValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return value.map(textValue).join('')
  return Object.entries(value)
    .filter(([key]) => !key.startsWith('@_'))
    .map(([, child]) => textValue(child))
    .join('')
}
