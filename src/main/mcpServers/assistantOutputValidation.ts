import path from 'node:path'

import AdmZip from 'adm-zip'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { PDFDocument } from 'pdf-lib'
import { PDFParse } from 'pdf-parse'
import sharp from 'sharp'

import { type OfficeRenderFormat, renderOfficeBufferToPdf, type RenderValidationMode } from './assistantOfficeRender'

export type GeneratedOutputFormat = 'md' | 'txt' | 'csv' | 'docx' | 'xlsx' | 'pptx' | 'pdf'

export interface GeneratedOutputVerification {
  passed: true
  checks: string[]
  warnings: string[]
  details: Record<string, number | string | boolean>
}

interface VerificationOptions {
  format: GeneratedOutputFormat
  buffer: Buffer
  expectedSlides?: number
  expectedMediaAssets?: number
  renderValidation?: RenderValidationMode
}

const REQUIRED_OOXML_PARTS: Partial<Record<GeneratedOutputFormat, string[]>> = {
  docx: ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'],
  xlsx: ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels'],
  pptx: ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels']
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })

function isUnsupportedTextControl(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? -1
  return (
    (codePoint >= 1 && codePoint <= 8) ||
    codePoint === 11 ||
    codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) ||
    codePoint === 127
  )
}

export async function verifyGeneratedOutput({
  format,
  buffer,
  expectedSlides,
  expectedMediaAssets = 0,
  renderValidation = 'auto'
}: VerificationOptions): Promise<GeneratedOutputVerification> {
  const checks = ['nonempty-buffer']
  const warnings: string[] = []
  const details: Record<string, number | string | boolean> = { bytes: buffer.length }
  const errors: string[] = []

  if (!buffer.length) errors.push('output buffer is empty')

  if (format === 'md' || format === 'txt' || format === 'csv') {
    validateTextOutput(format, buffer, checks, warnings, details, errors)
  } else if (format === 'pdf') {
    await validatePdfOutput(buffer, expectedMediaAssets, renderValidation, checks, warnings, details, errors)
  } else {
    await validateOoxmlOutput(
      format,
      buffer,
      expectedSlides,
      expectedMediaAssets,
      renderValidation,
      checks,
      warnings,
      details,
      errors
    )
  }

  if (errors.length) {
    throw new Error(`Generated ${format.toUpperCase()} failed delivery validation: ${errors.join('; ')}`)
  }

  return { passed: true, checks, warnings, details }
}

function validateTextOutput(
  format: 'md' | 'txt' | 'csv',
  buffer: Buffer,
  checks: string[],
  warnings: string[],
  details: Record<string, number | string | boolean>,
  errors: string[]
) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '')
  details.characters = [...text].length
  if (!text.trim()) errors.push('text output has no visible content')
  if (text.includes('\u0000')) errors.push('text output contains NUL characters')
  if (text.includes('\uFFFD')) errors.push('text output contains Unicode replacement characters')
  if ([...text].some(isUnsupportedTextControl)) {
    errors.push('text output contains unsupported control characters')
  }
  checks.push('utf8-text')

  if (format !== 'md') return

  const markdown = inspectMarkdown(text)
  details.headings = markdown.headingCount
  details.h1_headings = markdown.h1Count
  details.code_fences = markdown.fenceCount
  details.tables = markdown.tableCount
  errors.push(...markdown.errors)
  warnings.push(...markdown.warnings)
  checks.push('markdown-structure')
}

function inspectMarkdown(text: string) {
  const errors: string[] = []
  const warnings: string[] = []
  let activeFence: { character: string; length: number; line: number } | undefined
  let fenceCount = 0
  let headingCount = 0
  let h1Count = 0
  let previousHeadingLevel = 0
  let tableCount = 0
  const tableSeparators: number[] = []
  const lines = text.split(/\r?\n/)

  lines.forEach((line, index) => {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fence) {
      const marker = fence[1]
      if (!activeFence) {
        activeFence = { character: marker[0], length: marker.length, line: index + 1 }
        fenceCount += 1
      } else if (marker[0] === activeFence.character && marker.length >= activeFence.length) {
        activeFence = undefined
      }
      return
    }
    if (activeFence) return

    const heading = line.match(/^\s{0,3}(#{1,6})\s+\S/)
    if (heading) {
      const level = heading[1].length
      headingCount += 1
      if (level === 1) h1Count += 1
      if (previousHeadingLevel && level > previousHeadingLevel + 1) {
        warnings.push(`heading level jumps from H${previousHeadingLevel} to H${level} at line ${index + 1}`)
      }
      previousHeadingLevel = level
    }

    if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|){1,}\s*:?-{3,}:?\s*\|?\s*$/.test(line)) {
      tableCount += 1
      tableSeparators.push(index)
    }
  })

  if (activeFence) errors.push(`unclosed code fence opened at line ${activeFence.line}`)
  if (h1Count > 1) warnings.push(`document contains ${h1Count} top-level headings`)
  for (const separator of tableSeparators) {
    if (
      separator === 0 ||
      markdownTableColumnCount(lines[separator - 1]) !== markdownTableColumnCount(lines[separator])
    ) {
      errors.push(`malformed Markdown table separator at line ${separator + 1}`)
    }
  }
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    if (/^(?:data|javascript|vbscript):/i.test(match[1])) errors.push(`unsafe Markdown link target: ${match[1]}`)
  }
  return { errors, warnings, fenceCount, headingCount, h1Count, tableCount }
}

function markdownTableColumnCount(line: string) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  let columns = 1
  let escaped = false
  let inCode = false
  for (const character of trimmed) {
    if (escaped) escaped = false
    else if (character === '\\') escaped = true
    else if (character === '`') inCode = !inCode
    else if (character === '|' && !inCode) columns += 1
  }
  return columns
}

async function validatePdfOutput(
  buffer: Buffer,
  expectedMediaAssets: number,
  renderValidation: 'auto' | 'required' | 'skip',
  checks: string[],
  warnings: string[],
  details: Record<string, number | string | boolean>,
  errors: string[]
) {
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') errors.push('PDF header is missing')
  if (!buffer.subarray(Math.max(0, buffer.length - 2048)).includes(Buffer.from('%%EOF'))) {
    errors.push('PDF EOF marker is missing')
  }
  try {
    const document = await PDFDocument.load(buffer, { ignoreEncryption: false })
    const pages = document.getPageCount()
    details.pages = pages
    details.title = document.getTitle() || ''
    if (pages < 1) errors.push('PDF has no pages')
    const imageObjects = buffer.toString('latin1').match(/\/Subtype\s*\/Image\b/g)?.length ?? 0
    details.embedded_media_parts = imageObjects
    details.expected_image_assets = expectedMediaAssets
    if (expectedMediaAssets > 0 && imageObjects === 0)
      errors.push('PDF has image references but embeds no image objects')
    if (expectedMediaAssets > 0) checks.push('embedded-media')
    checks.push('pdf-structure', 'pdf-pages')
    await validateRenderedPdfPages(buffer, pages, renderValidation, checks, warnings, details, errors)
  } catch (error) {
    errors.push(`PDF parser rejected the output: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function validateRenderedPdfPages(
  buffer: Buffer,
  pageCount: number,
  mode: 'auto' | 'required' | 'skip',
  checks: string[],
  warnings: string[],
  details: Record<string, number | string | boolean>,
  errors: string[],
  checkName = 'pdf-rendered-pages'
) {
  if (mode === 'skip') {
    details.render_verification = 'skipped'
    return
  }

  const selectedPages = selectRenderedPages(pageCount)
  const parser = new PDFParse({ data: buffer })
  try {
    const screenshots = await parser.getScreenshot({
      partial: selectedPages,
      desiredWidth: 900,
      imageBuffer: true,
      imageDataUrl: false
    })
    let minimumInkRatio = 1
    let maximumEdgeInkShare = 0
    let minimumActiveAreaRatio = 1
    let maximumBottomGapRatio = 0
    const pageAnalyses: Array<{ pageNumber: number; analysis: Awaited<ReturnType<typeof analyzeRenderedPage>> }> = []

    for (const screenshot of screenshots.pages) {
      const analysis = await analyzeRenderedPage(Buffer.from(screenshot.data))
      pageAnalyses.push({ pageNumber: screenshot.pageNumber, analysis })
      minimumInkRatio = Math.min(minimumInkRatio, analysis.inkRatio)
      maximumEdgeInkShare = Math.max(maximumEdgeInkShare, analysis.edgeInkShare)
      minimumActiveAreaRatio = Math.min(minimumActiveAreaRatio, analysis.activeAreaRatio)
      maximumBottomGapRatio = Math.max(maximumBottomGapRatio, analysis.bottomGapRatio)
      if (analysis.inkRatio < 0.00025) {
        errors.push(`rendered PDF page ${screenshot.pageNumber} appears blank`)
      }
      if (analysis.edgeInkShare > 0.08) {
        warnings.push(`rendered PDF page ${screenshot.pageNumber} has content close to the page edge`)
      }
    }

    const medianInkRatio = median(pageAnalyses.map((page) => page.analysis.inkRatio))
    const sparsePages = pageAnalyses
      .filter(
        (page) =>
          page.pageNumber !== 1 &&
          page.pageNumber !== pageCount &&
          page.analysis.inkRatio >= 0.00025 &&
          page.analysis.inkRatio < Math.max(0.0015, medianInkRatio * 0.28)
      )
      .map((page) => page.pageNumber)
    const bottomHeavyWhitespacePages = pageAnalyses
      .filter(
        (page) =>
          page.pageNumber !== 1 &&
          page.pageNumber !== pageCount &&
          page.analysis.bottomGapRatio > 0.46 &&
          page.analysis.activeAreaRatio < 0.52 &&
          page.analysis.inkRatio < medianInkRatio * 0.75
      )
      .map((page) => page.pageNumber)
    if (sparsePages.length > 0) {
      warnings.push(
        `rendered pages ${summarizePageNumbers(sparsePages)} are much sparser than the deck median; confirm they are intentional section or statement pages`
      )
    }
    if (bottomHeavyWhitespacePages.length > 0) {
      warnings.push(
        `rendered pages ${summarizePageNumbers(bottomHeavyWhitespacePages)} leave an unusually large unused lower canvas; review content density and vertical balance`
      )
    }

    details.render_verification = 'passed'
    details.render_validation_scope = 'renderability,blank-pages,edge-content,density-outliers,vertical-balance'
    details.rendered_pages = screenshots.pages.length
    details.rendered_page_sample = selectedPages.length < pageCount ? 'sampled' : 'all'
    details.minimum_page_ink_ratio = Number(minimumInkRatio.toFixed(6))
    details.maximum_edge_ink_share = Number(maximumEdgeInkShare.toFixed(6))
    details.median_page_ink_ratio = Number(medianInkRatio.toFixed(6))
    details.minimum_active_area_ratio = Number(minimumActiveAreaRatio.toFixed(6))
    details.maximum_bottom_gap_ratio = Number(maximumBottomGapRatio.toFixed(6))
    details.sparse_page_outliers = sparsePages.length
    details.bottom_whitespace_outliers = bottomHeavyWhitespacePages.length
    checks.push(checkName)
  } catch (error) {
    details.render_verification = 'unavailable'
    const message = `PDF render verification is unavailable: ${error instanceof Error ? error.message : String(error)}`
    if (mode === 'required') errors.push(message)
    else warnings.push(message)
  } finally {
    await parser.destroy().catch(() => undefined)
  }
}

function selectRenderedPages(pageCount: number) {
  if (pageCount <= 20) return Array.from({ length: pageCount }, (_, index) => index + 1)
  const selected = new Set([1, 2, pageCount - 1, pageCount])
  for (let index = 1; index <= 16; index++) {
    selected.add(Math.max(1, Math.min(pageCount, Math.round((index * pageCount) / 17))))
  }
  return [...selected].sort((left, right) => left - right)
}

async function analyzeRenderedPage(data: Buffer) {
  const { data: pixels, info } = await sharp(data)
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const channels = info.channels
  const border = Math.max(2, Math.floor(Math.min(info.width, info.height) * 0.012))
  let inkPixels = 0
  let edgeInkPixels = 0
  let minimumX = info.width
  let minimumY = info.height
  let maximumX = -1
  let maximumY = -1

  for (let pixel = 0; pixel < info.width * info.height; pixel++) {
    const offset = pixel * channels
    const isInk = pixels[offset] < 248 || pixels[offset + 1] < 248 || pixels[offset + 2] < 248
    if (!isInk) continue
    inkPixels += 1
    const x = pixel % info.width
    const y = Math.floor(pixel / info.width)
    minimumX = Math.min(minimumX, x)
    minimumY = Math.min(minimumY, y)
    maximumX = Math.max(maximumX, x)
    maximumY = Math.max(maximumY, y)
    if (x < border || x >= info.width - border || y < border || y >= info.height - border) {
      edgeInkPixels += 1
    }
  }

  const activeWidth = maximumX >= minimumX ? maximumX - minimumX + 1 : 0
  const activeHeight = maximumY >= minimumY ? maximumY - minimumY + 1 : 0
  return {
    inkRatio: inkPixels / Math.max(1, info.width * info.height),
    edgeInkShare: edgeInkPixels / Math.max(1, inkPixels),
    activeAreaRatio: (activeWidth * activeHeight) / Math.max(1, info.width * info.height),
    bottomGapRatio: maximumY >= 0 ? (info.height - maximumY - 1) / info.height : 1,
    topGapRatio: minimumY < info.height ? minimumY / info.height : 1
  }
}

function median(values: number[]) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function summarizePageNumbers(values: number[]) {
  const visible = values.slice(0, 8).join(', ')
  return values.length > 8 ? `${visible} and ${values.length - 8} more` : visible
}

async function validateOoxmlOutput(
  format: 'docx' | 'xlsx' | 'pptx',
  buffer: Buffer,
  expectedSlides: number | undefined,
  expectedMediaAssets: number,
  renderValidation: RenderValidationMode,
  checks: string[],
  warnings: string[],
  details: Record<string, number | string | boolean>,
  errors: string[]
) {
  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch (error) {
    errors.push(`OOXML package cannot be opened: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const entries = zip.getEntries()
  const names = entries.map((entry) => entry.entryName)
  const nameSet = new Set(names)
  const duplicateEntries = duplicateValues(names)
  if (duplicateEntries.length) errors.push(`duplicate package entries: ${duplicateEntries.join(', ')}`)
  for (const required of REQUIRED_OOXML_PARTS[format] ?? []) {
    if (!nameSet.has(required)) errors.push(`missing required OOXML part: ${required}`)
  }

  const mediaPrefix = format === 'docx' ? 'word/media/' : format === 'pptx' ? 'ppt/media/' : 'xl/media/'
  const mediaParts = names.filter((name) => name.startsWith(mediaPrefix) && !name.endsWith('/'))
  details.embedded_media_parts = mediaParts.length
  details.expected_image_assets = expectedMediaAssets
  if (expectedMediaAssets > 0 && mediaParts.length === 0) {
    errors.push(`${format.toUpperCase()} has image references but embeds no internal media parts`)
  }
  if (expectedMediaAssets > 0) {
    validateEmbeddedMediaReferences(format, zip, names, expectedMediaAssets, details, errors)
    checks.push('embedded-media')
  }

  let xmlParts = 0
  for (const entry of entries) {
    if (entry.isDirectory || (!entry.entryName.endsWith('.xml') && !entry.entryName.endsWith('.rels'))) continue
    const xml = entry.getData().toString('utf8')
    const result = XMLValidator.validate(xml)
    if (result !== true) errors.push(`malformed XML part: ${entry.entryName}`)
    xmlParts += 1
  }

  const relationshipSummary = validatePackageRelationships(zip, names, nameSet)
  errors.push(...relationshipSummary.errors)
  warnings.push(...relationshipSummary.warnings)
  details.package_entries = entries.length
  details.xml_parts = xmlParts
  details.external_web_links = relationshipSummary.webLinks
  validateContentTypeTargets(zip, nameSet, errors)
  checks.push('ooxml-package', 'ooxml-xml', 'ooxml-relationships', 'ooxml-content-types')

  if (format === 'pptx') {
    validatePptxBaseline(zip, names, expectedSlides, checks, details, errors)
  } else if (format === 'docx') {
    const settings = zip.readAsText('word/settings.xml')
    const updateFields = settings.match(/<w:updateFields\b([^>]*)\/?\s*>/i)
    if (updateFields && !/w:val="(?:0|false|no|off)"/i.test(updateFields[1])) {
      errors.push('DOCX enables open-time field updates')
    }
    checks.push('docx-open-time-fields')
  }

  if ((format === 'docx' || format === 'pptx') && errors.length === 0) {
    await validateRenderedOfficeOutput(format, buffer, renderValidation, checks, warnings, details, errors)
  }
}

function validateEmbeddedMediaReferences(
  format: 'docx' | 'xlsx' | 'pptx',
  zip: AdmZip,
  names: string[],
  expectedMediaAssets: number,
  details: Record<string, number | string | boolean>,
  errors: string[]
) {
  if (format === 'xlsx') return
  const sources =
    format === 'docx'
      ? [{ xml: 'word/document.xml', relationships: 'word/_rels/document.xml.rels' }]
      : names
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .map((xml) => ({
            xml,
            relationships: `ppt/slides/_rels/${path.posix.basename(xml)}.rels`
          }))
  let referenceCount = 0

  for (const source of sources) {
    const xml = zip.readAsText(source.xml)
    const embeddedIds = [...xml.matchAll(/<a:blip\b[^>]*\br:embed="([^"]+)"/g)].map((match) => match[1])
    referenceCount += embeddedIds.length
    if (embeddedIds.length === 0) continue
    const relationships = readRelationships(zip, source.relationships)
    for (const id of embeddedIds) {
      const relationship = relationships.get(id)
      if (!relationship) {
        errors.push(`${source.xml} references missing image relationship ${id}`)
      } else if (!relationship.type.endsWith('/image') || relationship.external) {
        errors.push(`${source.xml} image reference ${id} is not a safe internal image relationship`)
      }
    }
  }

  details.embedded_media_references = referenceCount
  if (referenceCount < expectedMediaAssets) {
    errors.push(
      `${format.toUpperCase()} contains ${referenceCount} embedded image reference(s); expected at least ${expectedMediaAssets}`
    )
  }
}

function readRelationships(zip: AdmZip, partName: string) {
  const parsed = xmlParser.parse(zip.readAsText(partName)) as {
    Relationships?: { Relationship?: Record<string, string> | Array<Record<string, string>> }
  }
  const raw = parsed.Relationships?.Relationship
  const relationships = Array.isArray(raw) ? raw : raw ? [raw] : []
  return new Map(
    relationships.map((relationship) => [
      String(relationship.Id || ''),
      {
        type: String(relationship.Type || ''),
        external: String(relationship.TargetMode || '').toLowerCase() === 'external'
      }
    ])
  )
}

async function validateRenderedOfficeOutput(
  format: OfficeRenderFormat,
  buffer: Buffer,
  mode: RenderValidationMode,
  checks: string[],
  warnings: string[],
  details: Record<string, number | string | boolean>,
  errors: string[]
) {
  if (mode === 'skip') {
    details.render_verification = 'skipped'
    return
  }

  const rendered = await renderOfficeBufferToPdf(format, buffer, mode)
  if (rendered.status !== 'rendered' || !rendered.pdf) {
    details.render_verification = 'unavailable'
    if (rendered.renderer) details.render_renderer = rendered.renderer
    const message = `${format.toUpperCase()} render verification is ${rendered.status}: ${rendered.reason || 'unknown reason'}`
    if (mode === 'required') errors.push(message)
    else warnings.push(message)
    return
  }

  details.render_renderer = rendered.renderer || 'unknown'
  try {
    const document = await PDFDocument.load(rendered.pdf, { ignoreEncryption: false })
    await validateRenderedPdfPages(
      rendered.pdf,
      document.getPageCount(),
      'required',
      checks,
      warnings,
      details,
      errors,
      `${format}-rendered-pages`
    )
  } catch (error) {
    details.render_verification = 'unavailable'
    errors.push(
      `${format.toUpperCase()} rendered PDF is invalid: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function validateContentTypeTargets(zip: AdmZip, nameSet: Set<string>, errors: string[]) {
  const parsed = xmlParser.parse(zip.readAsText('[Content_Types].xml')) as {
    Types?: { Override?: Record<string, string> | Array<Record<string, string>> }
  }
  const raw = parsed.Types?.Override
  const overrides = Array.isArray(raw) ? raw : raw ? [raw] : []
  const parts = overrides.map((override) => String(override.PartName || '').replace(/^\//, '')).filter(Boolean)
  const repeated = duplicateValues(parts)
  if (repeated.length) errors.push(`duplicate content-type overrides: ${repeated.join(', ')}`)
  for (const part of parts) {
    if (!nameSet.has(part)) errors.push(`[Content_Types].xml targets missing part ${part}`)
  }
}

function validatePackageRelationships(zip: AdmZip, names: string[], nameSet: Set<string>) {
  const errors: string[] = []
  const warnings: string[] = []
  let webLinks = 0

  for (const name of names.filter((entry) => entry.endsWith('.rels'))) {
    const parsed = xmlParser.parse(zip.readAsText(name)) as {
      Relationships?: { Relationship?: Record<string, string> | Array<Record<string, string>> }
    }
    const raw = parsed.Relationships?.Relationship
    const relationships = Array.isArray(raw) ? raw : raw ? [raw] : []
    const ids = relationships.map((relationship) => relationship.Id || '').filter(Boolean)
    const repeatedIds = duplicateValues(ids)
    if (repeatedIds.length) errors.push(`${name} has duplicate relationship IDs: ${repeatedIds.join(', ')}`)
    const source = relationshipSource(name)

    for (const relationship of relationships) {
      const target = relationship.Target || ''
      if (String(relationship.TargetMode || '').toLowerCase() === 'external') {
        if (String(relationship.Type || '').endsWith('/hyperlink') && /^(?:https?|mailto):/i.test(target)) {
          webLinks += 1
          continue
        }
        errors.push(`${name} contains an unsafe external relationship: ${target || '(empty target)'}`)
        continue
      }
      const resolved = resolveRelationshipTarget(source, target)
      if (resolved && !nameSet.has(resolved)) errors.push(`${name} targets missing part ${resolved}`)
    }
  }

  if (webLinks) warnings.push(`${webLinks} external web hyperlink(s) require content review`)
  return { errors, warnings, webLinks }
}

function validatePptxBaseline(
  zip: AdmZip,
  names: string[],
  expectedSlides: number | undefined,
  checks: string[],
  details: Record<string, number | string | boolean>,
  errors: string[]
) {
  const slides = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort()
  details.slides = slides.length
  if (!slides.length) errors.push('PPTX has no slides')
  if (expectedSlides !== undefined && slides.length !== expectedSlides) {
    errors.push(`PPTX slide count mismatch: expected ${expectedSlides}, received ${slides.length}`)
  }

  for (const name of slides) {
    const xml = zip.readAsText(name)
    const ids = [...xml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)].map((match) => match[1])
    const repeatedIds = duplicateValues(ids)
    if (repeatedIds.length) errors.push(`${name} has duplicate shape IDs: ${repeatedIds.join(', ')}`)
    if (/<a:ext\b[^>]*(?:\bcx|\bcy)="-\d+"/g.test(xml)) errors.push(`${name} contains negative shape extents`)
  }
  checks.push('pptx-slides', 'pptx-shape-ids')
}

function relationshipSource(relsPath: string) {
  if (relsPath === '_rels/.rels') return ''
  const marker = '/_rels/'
  if (!relsPath.includes(marker) || !relsPath.endsWith('.rels')) return ''
  const [prefix, leaf] = relsPath.split(marker)
  return path.posix.join(prefix, leaf.slice(0, -5))
}

function resolveRelationshipTarget(source: string, target: string) {
  let decoded = target.replace(/\\/g, '/')
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    return ''
  }
  if (decoded.startsWith('/')) return path.posix.normalize(decoded.slice(1))
  return path.posix.normalize(path.posix.join(path.posix.dirname(source), decoded))
}

function duplicateValues(values: string[]) {
  const counts = new Map<string, number>()
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1))
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value)
}
