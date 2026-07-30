import { createRequire } from 'node:module'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import AdmZip from 'adm-zip'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'

import type { LoadedImageAsset } from './assistantAssets'

interface ZipArchive {
  append(source: Buffer, data: { name: string }): void
  finalize(): Promise<void>
  on(event: 'error', listener: (error: Error) => void): void
  pipe(destination: PassThrough): void
}

type ZipArchiveFactory = (format: 'zip', options: { zlib: { level: number } }) => ZipArchive

const loadModule = createRequire(import.meta.url)
const createZipArchive = loadModule('archiver') as ZipArchiveFactory

const SLIDE_RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'
const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
const TEMPLATE_MAX_SLIDES = 60

type OrderedXmlNode = Record<string, unknown>
type TemplateTextRole = 'title' | 'subtitle' | 'takeaway' | 'body'
type TemplateContentKind = 'index' | 'icon' | 'metric' | 'heading' | 'detail'
type TemplateLayoutKind = 'cover' | 'section' | 'chart' | 'metric' | 'table' | 'content'
type TemplateArrangement = 'list' | 'columns' | 'grid' | 'free'

export type PptxTemplateMode = 'edit-copy' | 'new-deck' | 'adaptive-design'

export interface PptxTemplateShapeReplacement {
  slide_number?: number
  shape_name?: string
  find_text?: string
  text?: string
}

export interface PptxTemplateInput {
  file_path?: string
  mode?: PptxTemplateMode
  source_slide_number?: number
  target_slide_number?: number
  shape_replacements?: PptxTemplateShapeReplacement[]
}

export interface PptxTemplateSlide {
  title: string
  subtitle?: string
  takeaway?: string
  layout?: string
  bullets: string[]
  notes?: string
  imageAssetId?: string
  preserveContent?: boolean
  templateSlideNumber?: number
  targetSlideNumber?: number
}

export interface PptxTemplateSummary {
  mode: PptxTemplateMode
  sourcePath: string
  sourceSlides: number
  outputSlides: number
  templateSlides: number[]
  editedSlides: number[]
  clonedSlides: number[]
  mastersPreserved: number
  layoutsPreserved: number
  mediaPreserved: number
  exactPackageReuse: boolean
  warnings: string[]
}

interface TemplateShape {
  children: OrderedXmlNode[]
  textBody: OrderedXmlNode
  name: string
  placeholderType: string
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
  role?: TemplateTextRole
}

interface TemplateContentItem {
  heading: string
  details: string[]
  value?: string
}

interface TemplateShapeCohort {
  shapes: TemplateShape[]
  kind: TemplateContentKind
}

export interface PptxTemplateSlideProfile {
  slideNumber: number
  kind: TemplateLayoutKind
  itemCapacity: number
  hasPicture: boolean
  hasChart: boolean
  hasTable: boolean
  metricLike: boolean
  arrangement: TemplateArrangement
  chartKind?: 'cartesian' | 'doughnut'
  sourceTextUnits: number
  sourceBodyTextUnits: number
  editableTextBlocks: number
  contentDensity: 'sparse' | 'balanced' | 'dense'
  targetBodyTextUnitsMin: number
  targetBodyTextUnitsMax: number
}

type TemplateSlideProfile = PptxTemplateSlideProfile

interface SlideUpdateResult {
  xml: string
  warnings: string[]
  updatedRoles: Set<TemplateTextRole>
  replacementCount: number
}

const orderedXmlOptions = {
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  preserveOrder: true,
  processEntities: false,
  trimValues: false
} as const

const orderedParser = new XMLParser(orderedXmlOptions)
const orderedBuilder = new XMLBuilder(orderedXmlOptions)
const relationshipParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true
})

export async function createPptxFromTemplate(
  source: Buffer,
  sourcePath: string,
  slides: PptxTemplateSlide[],
  input: PptxTemplateInput,
  assets: Map<string, LoadedImageAsset> = new Map()
): Promise<{ buffer: Buffer; summary: PptxTemplateSummary }> {
  const zip = new AdmZip(source)
  const orderedSlides = presentationSlideParts(zip)
  if (orderedSlides.length === 0) throw new Error('PPTX template contains no slides')
  if (orderedSlides.length > TEMPLATE_MAX_SLIDES) {
    throw new Error(`PPTX template exceeds the ${TEMPLATE_MAX_SLIDES}-slide template limit`)
  }

  const mode = input.mode || 'edit-copy'
  if (mode === 'adaptive-design') {
    throw new Error('adaptive-design is generated through the reference-style renderer, not native package reuse')
  }
  const warnings: string[] = []
  const replacements = normalizeReplacements(input.shape_replacements)
  const templateSlides: number[] = []
  const editedSlides: number[] = []
  const clonedSlides: number[] = []
  let outputSlideCount = mode === 'edit-copy' ? orderedSlides.length : slides.length

  if (mode === 'edit-copy') {
    if (slides.some((slide) => slide.preserveContent)) {
      throw new Error('preserve_content is only supported with pptx_template mode new-deck')
    }
    if (slides.length === 0 && replacements.length === 0) {
      throw new Error('edit-copy requires at least one slide update or shape replacement')
    }
    slides.forEach((slide, index) => {
      const target = normalizeSlideNumber(
        slide.targetSlideNumber || (slides.length === 1 ? input.target_slide_number : undefined) || index + 1,
        orderedSlides.length,
        'target_slide_number'
      )
      const partName = orderedSlides[target - 1]
      const updated = updateTemplateSlideXml(
        zip.readAsText(partName),
        slide,
        replacements.filter((item) => !item.slide_number || item.slide_number === target)
      )
      let updatedXml = updated.xml
      const relationshipPart = slideRelationshipPart(partName)
      let updatedRelationships = zip.readAsText(relationshipPart)
      if (slide.imageAssetId) {
        const asset = assets.get(slide.imageAssetId)
        if (!asset) throw new Error(`Slide ${target}: image asset '${slide.imageAssetId}' is unavailable`)
        const replacement = replaceDominantTemplatePicture(zip, updatedXml, updatedRelationships, asset, target)
        updatedRelationships = replacement.relationships
        const contrast = ensureTemplatePictureTextContrast(updatedXml)
        updatedXml = contrast.xml
        warnings.push(...contrast.warnings.map((warning) => `Slide ${target}: ${warning}`))
        warnings.push(...replacement.warnings.map((warning) => `Slide ${target}: ${warning}`))
      }
      const chartUpdate = updateTemplateChartData(zip, updatedXml, updatedRelationships, slide, target)
      updatedRelationships = chartUpdate.relationships
      zip.updateFile(partName, Buffer.from(updatedXml, 'utf-8'))
      zip.updateFile(relationshipPart, Buffer.from(updatedRelationships, 'utf-8'))
      warnings.push(...chartUpdate.warnings.map((warning) => `Slide ${target}: ${warning}`))
      warnings.push(...updated.warnings.map((warning) => `Slide ${target}: ${warning}`))
      editedSlides.push(target)
      templateSlides.push(target)
    })

    const replacementOnlySlides = new Set(
      replacements.map((item) => item.slide_number).filter((value): value is number => Boolean(value))
    )
    for (const targetValue of replacementOnlySlides) {
      const target = normalizeSlideNumber(targetValue, orderedSlides.length, 'shape_replacements.slide_number')
      if (editedSlides.includes(target)) continue
      const partName = orderedSlides[target - 1]
      const updated = updateTemplateSlideXml(
        zip.readAsText(partName),
        undefined,
        replacements.filter((item) => item.slide_number === target)
      )
      zip.updateFile(partName, Buffer.from(updated.xml, 'utf-8'))
      warnings.push(...updated.warnings.map((warning) => `Slide ${target}: ${warning}`))
      editedSlides.push(target)
      templateSlides.push(target)
    }

    if (replacements.some((item) => !item.slide_number) && editedSlides.length === 0) {
      const target = normalizeSlideNumber(input.target_slide_number || 1, orderedSlides.length, 'target_slide_number')
      const partName = orderedSlides[target - 1]
      const updated = updateTemplateSlideXml(zip.readAsText(partName), undefined, replacements)
      zip.updateFile(partName, Buffer.from(updated.xml, 'utf-8'))
      warnings.push(...updated.warnings.map((warning) => `Slide ${target}: ${warning}`))
      editedSlides.push(target)
      templateSlides.push(target)
    }
  } else {
    if (slides.length === 0) throw new Error('new-deck requires at least one slide definition')
    if (slides.length > TEMPLATE_MAX_SLIDES) {
      throw new Error(`new-deck exceeds the ${TEMPLATE_MAX_SLIDES}-slide output limit`)
    }
    const sourceSlides = orderedSlides.map((partName) => ({
      partName,
      xml: zip.readAsText(partName),
      relationships: zip.readAsText(slideRelationshipPart(partName))
    }))
    sourceSlides.forEach((slide) => {
      if (!slide.xml || !slide.relationships)
        throw new Error(`PPTX template has an unreadable slide: ${slide.partName}`)
    })

    const profiles = sourceSlides.map((sourceSlide, index) =>
      profileTemplateSlide(sourceSlide.xml, index + 1, zip, sourceSlide.relationships)
    )
    const adaptiveSlides =
      replacements.length === 0 ? prepareAdaptiveTemplateSlides(slides, profiles, warnings) : slides
    if (replacements.length === 0) {
      const densityValidation = validateAdaptiveTemplateContentDensity(adaptiveSlides, profiles)
      warnings.push(...densityValidation.warnings)
      if (densityValidation.errors.length > 0) {
        throw new Error(
          `Native template content planning is too sparse: ${densityValidation.errors.join('; ')}. Expand the content internally with evidence, interpretation, and actions, or remap to a sparser source layout; do not ask the user to rewrite the prompt.`
        )
      }
    }
    outputSlideCount = adaptiveSlides.length
    const preparedSlides = adaptiveSlides.map((slide, index) => {
      const sourceSlideNumber = normalizeSlideNumber(
        slide.templateSlideNumber || input.source_slide_number || Math.min(index + 1, sourceSlides.length),
        sourceSlides.length,
        'source_slide_number'
      )
      const sourceSlide = sourceSlides[sourceSlideNumber - 1]
      const outputSlideNumber = index + 1
      const slideReplacements = replacements.filter(
        (item) => !item.slide_number || item.slide_number === outputSlideNumber
      )
      if (slide.preserveContent && slideReplacements.length > 0) {
        throw new Error(`Slide ${outputSlideNumber}: preserve_content cannot be combined with shape_replacements`)
      }
      const updated = slide.preserveContent
        ? {
            xml: sourceSlide.xml,
            warnings: [],
            updatedRoles: new Set<TemplateTextRole>(),
            replacementCount: 0
          }
        : updateTemplateSlideXml(sourceSlide.xml, slide, slideReplacements)
      warnings.push(...updated.warnings.map((warning) => `Slide ${outputSlideNumber}: ${warning}`))
      templateSlides.push(sourceSlideNumber)
      if (slide.preserveContent) clonedSlides.push(outputSlideNumber)
      else editedSlides.push(outputSlideNumber)
      let preparedXml = updated.xml
      let preparedRelationships = stripSlideLocalRelationships(sourceSlide.relationships)
      if (slide.imageAssetId) {
        const asset = assets.get(slide.imageAssetId)
        if (!asset) throw new Error(`Slide ${outputSlideNumber}: image asset '${slide.imageAssetId}' is unavailable`)
        const replacement = replaceDominantTemplatePicture(
          zip,
          preparedXml,
          preparedRelationships,
          asset,
          outputSlideNumber
        )
        preparedRelationships = replacement.relationships
        const contrast = ensureTemplatePictureTextContrast(preparedXml)
        preparedXml = contrast.xml
        warnings.push(...contrast.warnings.map((warning) => `Slide ${outputSlideNumber}: ${warning}`))
        warnings.push(...replacement.warnings.map((warning) => `Slide ${outputSlideNumber}: ${warning}`))
      }
      if (!slide.preserveContent) {
        const chartUpdate = updateTemplateChartData(zip, preparedXml, preparedRelationships, slide, outputSlideNumber)
        preparedRelationships = chartUpdate.relationships
        warnings.push(...chartUpdate.warnings.map((warning) => `Slide ${outputSlideNumber}: ${warning}`))
      }
      return {
        xml: preparedXml,
        relationships: preparedRelationships
      }
    })

    rebuildSlideCollection(zip, preparedSlides)
  }

  const summary: PptxTemplateSummary = {
    mode,
    sourcePath,
    sourceSlides: orderedSlides.length,
    outputSlides: outputSlideCount,
    templateSlides: uniqueNumbers(templateSlides),
    editedSlides: uniqueNumbers(editedSlides),
    clonedSlides: uniqueNumbers(clonedSlides),
    mastersPreserved: countParts(zip, /^ppt\/slideMasters\/slideMaster\d+\.xml$/),
    layoutsPreserved: countParts(zip, /^ppt\/slideLayouts\/slideLayout\d+\.xml$/),
    mediaPreserved: countParts(zip, /^ppt\/media\//),
    exactPackageReuse: true,
    warnings: uniqueStrings(warnings)
  }
  return { buffer: await serializeOfficeZip(zip), summary }
}

async function serializeOfficeZip(zip: AdmZip): Promise<Buffer> {
  const archive = createZipArchive('zip', { zlib: { level: 6 } })
  const output = new PassThrough()
  const chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => {
    output.on('data', (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)))
    output.on('end', () => resolve(Buffer.concat(chunks)))
    output.on('error', reject)
    archive.on('error', reject)
  })

  archive.pipe(output)
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory) archive.append(entry.getData(), { name: entry.entryName })
  }
  await archive.finalize()
  return completed
}

export function pptxTemplateSummary(summary: PptxTemplateSummary) {
  return {
    mode: summary.mode,
    source_path: summary.sourcePath,
    source_slides: summary.sourceSlides,
    output_slides: summary.outputSlides,
    template_slides: summary.templateSlides,
    edited_slides: summary.editedSlides,
    cloned_slides: summary.clonedSlides,
    masters_preserved: summary.mastersPreserved,
    layouts_preserved: summary.layoutsPreserved,
    media_preserved: summary.mediaPreserved,
    exact_package_reuse: summary.exactPackageReuse,
    warnings: summary.warnings
  }
}

export function profilePptxTemplateSlides(source: Buffer) {
  const zip = new AdmZip(source)
  return presentationSlideParts(zip).map((partName, index) =>
    profileTemplateSlide(zip.readAsText(partName), index + 1, zip, zip.readAsText(slideRelationshipPart(partName)))
  )
}

function presentationSlideParts(zip: AdmZip): string[] {
  const presentation = zip.readAsText('ppt/presentation.xml')
  const relationships = zip.readAsText('ppt/_rels/presentation.xml.rels')
  if (!presentation || !relationships) throw new Error('PPTX template is missing presentation relationships')
  const relationshipMap = parseRelationships(relationships)
  const relationshipIds = [...presentation.matchAll(/<(?:[\w.-]+:)?sldId\b[^>]*\br:id="([^"]+)"[^>]*\/?\s*>/g)].map(
    (match) => match[1]
  )
  const parts = relationshipIds
    .map((id) => relationshipMap.get(id))
    .filter((relationship): relationship is { target: string; type: string } => Boolean(relationship))
    .filter((relationship) => relationship.type === SLIDE_RELATIONSHIP_TYPE)
    .map((relationship) => resolveRelationshipTarget('ppt/presentation.xml', relationship.target))
  return parts.filter((partName) => Boolean(zip.getEntry(partName)))
}

function parseRelationships(source: string) {
  const parsed = relationshipParser.parse(source) as {
    Relationships?: { Relationship?: Record<string, string> | Array<Record<string, string>> }
  }
  const raw = parsed.Relationships?.Relationship
  const relationships = Array.isArray(raw) ? raw : raw ? [raw] : []
  return new Map(
    relationships
      .map(
        (relationship) =>
          [
            String(relationship.Id || ''),
            { target: String(relationship.Target || ''), type: String(relationship.Type || '') }
          ] as const
      )
      .filter(([id]) => Boolean(id))
  )
}

function rebuildSlideCollection(zip: AdmZip, slides: Array<{ xml: string; relationships: string }>): void {
  for (const entry of [...zip.getEntries()]) {
    if (
      /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName) ||
      /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(entry.entryName) ||
      entry.entryName.startsWith('ppt/notesSlides/') ||
      entry.entryName.startsWith('ppt/notesMasters/')
    ) {
      zip.deleteFile(entry.entryName)
    }
  }

  slides.forEach((slide, index) => {
    const number = index + 1
    zip.addFile(`ppt/slides/slide${number}.xml`, Buffer.from(slide.xml, 'utf-8'))
    zip.addFile(`ppt/slides/_rels/slide${number}.xml.rels`, Buffer.from(slide.relationships, 'utf-8'))
  })

  const presentation = zip.readAsText('ppt/presentation.xml')
  const presentationRelationships = zip.readAsText('ppt/_rels/presentation.xml.rels')
  const contentTypes = zip.readAsText('[Content_Types].xml')
  if (!presentation || !presentationRelationships || !contentTypes) {
    throw new Error('PPTX template is missing required package parts')
  }

  const withoutSlideRelationships = presentationRelationships.replace(
    /<Relationship\b(?=[^>]*\bType="[^"]*\/(?:slide|notesSlide|notesMaster)")(?=[^>]*\bId="[^"]+")[^>]*(?:\/>|>\s*<\/Relationship>)/g,
    ''
  )
  const usedRelationshipIds = new Set(
    [
      ...withoutSlideRelationships.matchAll(/\bId="(rId\d+)"/g),
      ...presentationRelationships.matchAll(
        /<Relationship\b(?=[^>]*\bType="[^"]*\/notesMaster")(?=[^>]*\bId="(rId\d+)")[^>]*>/g
      )
    ].map((match) => Number(match[1].slice(3)))
  )
  const relationshipIds = slides.map(() => nextRelationshipId(usedRelationshipIds))
  const relationshipXml = slides
    .map(
      (_, index) =>
        `<Relationship Id="${relationshipIds[index]}" Type="${SLIDE_RELATIONSHIP_TYPE}" Target="slides/slide${index + 1}.xml"/>`
    )
    .join('')
  zip.updateFile(
    'ppt/_rels/presentation.xml.rels',
    Buffer.from(withoutSlideRelationships.replace('</Relationships>', `${relationshipXml}</Relationships>`), 'utf-8')
  )

  const slideList = `<p:sldIdLst>${relationshipIds
    .map((relationshipId, index) => `<p:sldId id="${256 + index}" r:id="${relationshipId}"/>`)
    .join('')}</p:sldIdLst>`
  let updatedPresentation = presentation.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, slideList)
  updatedPresentation = updatedPresentation.replace(/<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>/g, '')
  updatedPresentation = updatedPresentation.replace(/<p:custShowLst>[\s\S]*?<\/p:custShowLst>/g, '')
  updatedPresentation = updatedPresentation.replace(/<p14:sectionLst[\s\S]*?<\/p14:sectionLst>/g, '')
  zip.updateFile('ppt/presentation.xml', Buffer.from(updatedPresentation, 'utf-8'))

  const slideOverrides = slides
    .map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="${SLIDE_CONTENT_TYPE}"/>`)
    .join('')
  const updatedContentTypes = contentTypes
    .replace(/<Override\b[^>]*PartName="\/ppt\/slides\/slide\d+\.xml"[^>]*(?:\/>|>\s*<\/Override>)/g, '')
    .replace(/<Override\b[^>]*PartName="\/ppt\/notesSlides\/[^"/]+\.xml"[^>]*(?:\/>|>\s*<\/Override>)/g, '')
    .replace(/<Override\b[^>]*PartName="\/ppt\/notesMasters\/[^"/]+\.xml"[^>]*(?:\/>|>\s*<\/Override>)/g, '')
    .replace('</Types>', `${slideOverrides}</Types>`)
  zip.updateFile('[Content_Types].xml', Buffer.from(updatedContentTypes, 'utf-8'))

  const appProperties = zip.readAsText('docProps/app.xml')
  if (appProperties) {
    zip.updateFile(
      'docProps/app.xml',
      Buffer.from(
        appProperties
          .replace(/<Slides>\d+<\/Slides>/, `<Slides>${slides.length}</Slides>`)
          .replace(/<Notes>\d+<\/Notes>/, '<Notes>0</Notes>'),
        'utf-8'
      )
    )
  }
}

function profileTemplateSlide(
  source: string,
  slideNumber: number,
  zip?: AdmZip,
  relationshipsXml?: string
): TemplateSlideProfile {
  const document = orderedParser.parse(source) as OrderedXmlNode[]
  const shapes = collectTemplateShapes(document)
  assignFallbackRoles(shapes)
  const bodyShapes = shapes.filter((shape) => shape.role === 'body' && isEditableTemplateShape(shape))
  const cohorts = collectTemplateShapeCohorts(bodyShapes)
  let itemCapacity = inferTemplateItemCapacity(cohorts, bodyShapes)
  const hasPicture = /<p:pic(?:\s|>)/.test(source)
  const hasChart = /<c:chart(?:\s|>)/.test(source)
  const chartKind = hasChart ? resolveTemplateChartKind(source, zip, relationshipsXml) : undefined
  const hasTable = /<a:tbl(?:\s|>)/.test(source)
  const metricShapeCount = shapes.filter((shape) => !isIndexText(shape.text) && isMetricText(shape.text)).length
  const metricLike =
    metricShapeCount >= 2 || cohorts.some((cohort) => cohort.kind === 'metric' && cohort.shapes.length >= 2)
  if (metricLike) itemCapacity = Math.max(itemCapacity, metricShapeCount)
  const arrangement = inferTemplateArrangement(cohorts, itemCapacity)
  const kind: TemplateLayoutKind =
    slideNumber === 1 && (hasPicture || itemCapacity <= 1)
      ? 'cover'
      : hasChart
        ? 'chart'
        : hasTable
          ? 'table'
          : metricLike
            ? 'metric'
            : hasPicture && (itemCapacity <= 1 || arrangement === 'free')
              ? 'section'
              : 'content'
  const editableTextShapes = shapes.filter(
    (shape) =>
      isEditableTemplateShape(shape) &&
      !isIndexText(shape.text) &&
      !isIconText(shape.text) &&
      !isStaleTemplateTopicLabel(shape.text)
  )
  const sourceTextUnits = editableTextShapes.reduce((sum, shape) => sum + equivalentTextLength(shape.text), 0)
  const sourceBodyTextUnits = editableTextShapes
    .filter((shape) => shape.role === 'body')
    .reduce((sum, shape) => sum + equivalentTextLength(shape.text), 0)
  const contentDensity = templateContentDensity(sourceBodyTextUnits, itemCapacity, kind)
  const minimumRatio = contentDensity === 'dense' ? 0.68 : contentDensity === 'balanced' ? 0.56 : 0.42
  const maximumRatio = contentDensity === 'dense' ? 1.08 : contentDensity === 'balanced' ? 1.15 : 1.25
  return {
    slideNumber,
    kind,
    itemCapacity,
    hasPicture,
    hasChart,
    hasTable,
    metricLike,
    arrangement,
    chartKind,
    sourceTextUnits,
    sourceBodyTextUnits,
    editableTextBlocks: editableTextShapes.length,
    contentDensity,
    targetBodyTextUnitsMin: Math.round(sourceBodyTextUnits * minimumRatio),
    targetBodyTextUnitsMax: Math.round(sourceBodyTextUnits * maximumRatio)
  }
}

function resolveTemplateChartKind(
  slideXml: string,
  zip: AdmZip | undefined,
  relationshipsXml: string | undefined
): 'cartesian' | 'doughnut' {
  if (!zip || !relationshipsXml) return 'cartesian'
  const relationshipId = slideXml.match(/<c:chart\b[^>]*\br:id="([^"]+)"/)?.[1]
  if (!relationshipId) return 'cartesian'
  const relationship = parseRelationships(relationshipsXml).get(relationshipId)
  if (!relationship) return 'cartesian'
  const chartPart = resolveRelationshipTarget('ppt/slides/slide1.xml', relationship.target)
  const chartXml = zip.readAsText(chartPart)
  return /<c:(?:doughnut|pie)Chart(?:\s|>)/.test(chartXml) ? 'doughnut' : 'cartesian'
}

function prepareAdaptiveTemplateSlides(
  slides: PptxTemplateSlide[],
  profiles: TemplateSlideProfile[],
  warnings: string[]
): PptxTemplateSlide[] {
  const prepared: PptxTemplateSlide[] = []
  const usedChartTemplates = new Set<number>()
  for (const [index, rawSlide] of slides.entries()) {
    const slide = normalizeTemplateSlideSemantics(rawSlide)
    if (slide.preserveContent) {
      prepared.push(slide)
      continue
    }
    if (!slide.layout) {
      prepared.push(slide)
      continue
    }
    const requested = slide.templateSlideNumber || Math.min(index + 1, profiles.length)
    let selected = selectAdaptiveTemplateProfile(slide, requested, profiles)
    if (slide.layout === 'chart' && selected.hasChart && usedChartTemplates.has(selected.slideNumber)) {
      const unusedChart = profiles
        .filter(
          (profile) =>
            profile.hasChart && profile.chartKind === 'cartesian' && !usedChartTemplates.has(profile.slideNumber)
        )
        .sort(
          (left, right) => templateProfileScore(right, slide, requested) - templateProfileScore(left, slide, requested)
        )[0]
      const contentFallback = profiles
        .filter(
          (profile) => profile.kind === 'content' && !profile.hasChart && !profile.hasTable && !profile.hasPicture
        )
        .sort(
          (left, right) =>
            templateProfileScore(right, { ...slide, layout: 'cards' }, requested) -
            templateProfileScore(left, { ...slide, layout: 'cards' }, requested)
        )[0]
      selected = unusedChart || contentFallback || selected
      warnings.push(
        `Output slide ${index + 1} avoided reusing native chart page ${requested}; repeated chart parts are not shared, so a distinct chart or data-layout page ${selected.slideNumber} was selected`
      )
    }
    if (selected.hasChart) usedChartTemplates.add(selected.slideNumber)
    const canSplit = isSplittableTemplateLayout(slide.layout)
    const capacity = Math.max(1, selected.itemCapacity)
    if (canSplit && slide.bullets.length > capacity && capacity >= 2) {
      const chunks = chunkItems(slide.bullets, capacity)
      chunks.forEach((bullets, chunkIndex) => {
        const continuation: PptxTemplateSlide = {
          ...slide,
          title: chunkIndex === 0 ? slide.title : `${slide.title}（续）`,
          subtitle: chunkIndex === 0 ? slide.subtitle : undefined,
          takeaway: chunkIndex === 0 ? slide.takeaway : undefined,
          bullets,
          templateSlideNumber: selected.slideNumber
        }
        prepared.push(continuation)
      })
      warnings.push(
        `Output slide ${index + 1} was split into ${chunks.length} pages because its ${slide.bullets.length} content items exceeded the selected template page capacity of ${capacity}`
      )
      continue
    }
    if (selected.slideNumber !== requested) {
      warnings.push(
        `Output slide ${index + 1} was remapped from template page ${requested} to page ${selected.slideNumber} to fit its ${slide.layout || 'content'} structure and ${slide.bullets.length} content items`
      )
    }
    prepared.push({ ...slide, templateSlideNumber: selected.slideNumber })
  }
  return prepared
}

function validateAdaptiveTemplateContentDensity(slides: PptxTemplateSlide[], profiles: TemplateSlideProfile[]) {
  const errors: string[] = []
  const warnings: string[] = []
  const compactLayouts = new Set(['cover', 'section', 'quote', 'summary', 'metric', 'chart'])

  slides.forEach((slide, index) => {
    if (slide.preserveContent || compactLayouts.has(slide.layout || '')) return
    const profile = profiles[(slide.templateSlideNumber || Math.min(index + 1, profiles.length)) - 1]
    if (!profile || ['cover', 'section', 'chart', 'metric', 'table'].includes(profile.kind)) return
    if (
      profile.sourceBodyTextUnits < 90 ||
      slide.bullets.length < Math.max(2, Math.ceil(profile.itemCapacity * 0.55))
    ) {
      return
    }
    const bodyText = [slide.subtitle, slide.takeaway, ...slide.bullets].filter(Boolean).join(' ')
    const actualUnits = equivalentTextLength(bodyText)
    if (actualUnits < profile.targetBodyTextUnitsMin) {
      const issue =
        `output slide ${index + 1} mapped to template page ${profile.slideNumber} provides ${actualUnits} body-text units; ` +
        `the ${profile.contentDensity} source layout needs at least ${profile.targetBodyTextUnitsMin}`
      if (profile.contentDensity === 'dense') errors.push(issue)
      else warnings.push(`${issue}; enrich the slide or choose a sparser page`)
    } else if (actualUnits > profile.targetBodyTextUnitsMax * 1.15) {
      warnings.push(
        `Output slide ${index + 1} exceeds the safe density of template page ${profile.slideNumber} ` +
          `(${actualUnits} vs ${profile.targetBodyTextUnitsMax} body-text units); split or remap before reducing font size`
      )
    }
  })

  return { errors, warnings }
}

function normalizeTemplateSlideSemantics(slide: PptxTemplateSlide): PptxTemplateSlide {
  if (slide.layout !== 'section' || !/^\s*(?:chapter\s*)?\d{1,2}\s*$/i.test(slide.title) || !slide.subtitle) {
    return slide
  }
  return {
    ...slide,
    title: slide.subtitle,
    subtitle: slide.takeaway,
    takeaway: undefined
  }
}

function selectAdaptiveTemplateProfile(
  slide: PptxTemplateSlide,
  requestedSlideNumber: number,
  profiles: TemplateSlideProfile[]
): TemplateSlideProfile {
  const requested = profiles[Math.max(0, Math.min(profiles.length - 1, requestedSlideNumber - 1))]
  const ranked = [...profiles].sort(
    (left, right) =>
      templateProfileScore(right, slide, requestedSlideNumber) - templateProfileScore(left, slide, requestedSlideNumber)
  )
  const best = ranked[0] || requested
  const requestedScore = templateProfileScore(requested, slide, requestedSlideNumber)
  const bestScore = templateProfileScore(best, slide, requestedSlideNumber)
  if (slide.bullets.length > requested.itemCapacity && isSplittableTemplateLayout(slide.layout)) {
    const fitting = ranked.find(
      (profile) =>
        profile.itemCapacity >= slide.bullets.length &&
        profile.kind !== 'cover' &&
        profile.kind !== 'section' &&
        !profile.hasChart &&
        !profile.hasTable &&
        (!profile.hasPicture || Boolean(slide.imageAssetId))
    )
    if (fitting && templateProfileScore(fitting, slide, requestedSlideNumber) >= requestedScore - 15) return fitting
  }
  return bestScore >= requestedScore + 18 ? best : requested
}

function templateProfileScore(profile: TemplateSlideProfile, slide: PptxTemplateSlide, requestedSlideNumber: number) {
  const numericItems = templateChartData(slide).length
  const layout =
    (slide.layout === 'chart' || slide.layout === 'metric') && numericItems < 2
      ? slide.imageAssetId
        ? 'image'
        : 'insight'
      : slide.layout || 'insight'
  const itemCount = slide.bullets.length
  let score = profile.slideNumber === requestedSlideNumber ? 12 : 0
  if (layout === 'cover') score += profile.kind === 'cover' ? 130 : -80
  else if (layout === 'section') score += profile.kind === 'section' ? 115 : profile.hasPicture ? 40 : -45
  else if (layout === 'chart') {
    score += profile.hasChart ? (profile.chartKind === 'cartesian' ? 130 : 88) : -90
  } else if (layout === 'metric') score += profile.metricLike ? 110 : profile.kind === 'content' ? 10 : -45
  else if (layout === 'image') score += profile.hasPicture ? 70 : -55
  else if (layout === 'quote' || layout === 'summary') score += profile.hasPicture ? 42 : 8
  else score += profile.kind === 'content' ? 55 : profile.kind === 'metric' ? 12 : -45

  if (profile.hasTable && layout !== 'comparison') score -= 75
  if (profile.hasChart && layout !== 'chart') score -= 55
  if (profile.hasPicture && !slide.imageAssetId && !['cover', 'section', 'quote', 'summary'].includes(layout)) {
    score -= 90
  }
  if (layout === 'agenda') score += profile.arrangement === 'list' ? 30 : -8
  if (layout === 'cards') score += ['grid', 'columns'].includes(profile.arrangement) ? 32 : -12
  if (layout === 'process' || layout === 'timeline') {
    score += ['grid', 'list'].includes(profile.arrangement) ? 24 : 4
  }
  if (layout === 'comparison') score += ['columns', 'grid'].includes(profile.arrangement) ? 30 : -10
  if (layout === 'image' && itemCount > 1) {
    score += ['columns', 'grid'].includes(profile.arrangement) ? 30 : -20
  }
  if (itemCount > 0 && profile.kind !== 'section' && profile.kind !== 'cover') {
    score += 34 - Math.abs(profile.itemCapacity - itemCount) * 11
    if (profile.itemCapacity < itemCount) score -= (itemCount - profile.itemCapacity) * 20
  }
  return score
}

function isSplittableTemplateLayout(layout: string | undefined) {
  return ['agenda', 'insight', 'cards', 'process', 'timeline', 'comparison', 'image'].includes(layout || '')
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

function updateTemplateSlideXml(
  source: string,
  slide: PptxTemplateSlide | undefined,
  replacements: Required<Pick<PptxTemplateShapeReplacement, 'text'>>[] & PptxTemplateShapeReplacement[]
): SlideUpdateResult {
  if (!source) throw new Error('PPTX template contains an unreadable slide')
  const document = orderedParser.parse(source) as OrderedXmlNode[]
  const shapes = collectTemplateShapes(document)
  const warnings: string[] = []
  const updatedRoles = new Set<TemplateTextRole>()
  let replacementCount = 0

  for (const replacement of replacements) {
    const matches = shapes.filter((shape) => matchesReplacement(shape, replacement))
    if (matches.length === 0) {
      warnings.push(
        `shape replacement did not match ${replacement.shape_name || replacement.find_text || 'the requested shape'}`
      )
      continue
    }
    for (const shape of matches) {
      replaceTextBody(shape.textBody, [replacement.text || ''], 1600)
      replacementCount++
    }
  }

  if (slide) {
    assignFallbackRoles(shapes)
    const roleShapes = (role: TemplateTextRole) => shapes.filter((shape) => shape.role === role)
    applySingleRole(roleShapes('title'), slide.title ? [slide.title] : [], 'title', updatedRoles, warnings)
    const takeawayShapes = roleShapes('takeaway')
    const subtitleContent =
      slide.subtitle ||
      (takeawayShapes.length === 0 ? slide.takeaway || summarizeTemplateBulletHeadings(slide.bullets) : undefined)
    applySingleRole(
      roleShapes('subtitle'),
      subtitleContent ? [subtitleContent] : [],
      'subtitle',
      updatedRoles,
      warnings
    )
    applySingleRole(takeawayShapes, slide.takeaway ? [slide.takeaway] : [], 'takeaway', updatedRoles, warnings)

    const bodyShapes = roleShapes('body').filter(isEditableTemplateShape)
    const bodyItems = slide.bullets.length ? slide.bullets : slide.takeaway ? [slide.takeaway] : []
    if (bodyShapes.length > 0) {
      applyAdaptiveBodyContent(bodyShapes, bodyItems, slide.layout, warnings)
      updatedRoles.add('body')
    } else if (bodyItems.length > 0) {
      warnings.push('no body placeholder or safe body text shape was found; body content was not inserted')
    }
    shapes
      .filter((shape) => !shape.role && isStaleTemplateTopicLabel(shape.text))
      .forEach((shape) => replaceTextBody(shape.textBody, [], 1000))
  }

  return {
    xml: orderedBuilder.build(document),
    warnings,
    updatedRoles,
    replacementCount
  }
}

function collectTemplateShapes(document: OrderedXmlNode[]): TemplateShape[] {
  const shapes: TemplateShape[] = []
  walkOrdered(document, (node) => {
    if (!Object.hasOwn(node, 'p:sp')) return
    const children = node['p:sp']
    if (!Array.isArray(children)) return
    const textBody = findOrderedElement(children as OrderedXmlNode[], 'p:txBody')
    if (!textBody) return
    const nonVisual = findOrderedElement(children as OrderedXmlNode[], 'p:cNvPr')
    const placeholder = findOrderedElement(children as OrderedXmlNode[], 'p:ph')
    const offset = findOrderedElement(children as OrderedXmlNode[], 'a:off')
    const extent = findOrderedElement(children as OrderedXmlNode[], 'a:ext')
    const name = orderedAttribute(nonVisual, 'name') || ''
    const placeholderType = orderedAttribute(placeholder, 'type') || ''
    const text = collectOrderedText(elementChildren(textBody, 'p:txBody'))
    const shape: TemplateShape = {
      children: children as OrderedXmlNode[],
      textBody,
      name,
      placeholderType,
      text,
      x: orderedNumber(offset, 'x'),
      y: orderedNumber(offset, 'y'),
      width: orderedNumber(extent, 'cx'),
      height: orderedNumber(extent, 'cy'),
      fontSize: largestFontSize(elementChildren(textBody, 'p:txBody'))
    }
    shape.role = classifyShapeRole(shape)
    shapes.push(shape)
  })
  return shapes
}

function classifyShapeRole(shape: TemplateShape): TemplateTextRole | undefined {
  const placeholder = shape.placeholderType.toLowerCase()
  const name = shape.name.toLowerCase()
  if (placeholder === 'title' || placeholder === 'ctrtitle') return 'title'
  if (placeholder === 'subtitle') return 'subtitle'
  if (placeholder === 'body' || placeholder === 'obj') return 'body'
  if (/takeaway|key[ _-]?message|conclusion|结论|核心观点|摘要/i.test(name)) return 'takeaway'
  if (/subtitle|sub[ _-]?title|副标题/i.test(name)) return 'subtitle'
  if (/^(?:title|heading|标题)(?:[ _-]?\d+)?$/i.test(name)) return 'title'
  if (/^(?:body|content|正文|内容|要点)(?:[ _-]?\d+)?$/i.test(name)) return 'body'
  return undefined
}

function assignFallbackRoles(shapes: TemplateShape[]): void {
  const usable = shapes.filter(isEditableTemplateShape)
  const repeatedContentShapes = new Set(
    collectTemplateShapeCohorts(usable)
      .filter((cohort) => cohort.shapes.length >= 2)
      .flatMap((cohort) => cohort.shapes)
  )
  const structuralCandidates = usable.filter((shape) => !repeatedContentShapes.has(shape))
  if (!shapes.some((shape) => shape.role === 'title')) {
    const title = (structuralCandidates.length > 0 ? structuralCandidates : usable)
      .filter(
        (shape) => !shape.role && !isIndexText(shape.text) && !isIconText(shape.text) && !isMetricText(shape.text)
      )
      .sort((left, right) => templateTitleScore(right) - templateTitleScore(left))[0]
    if (title) title.role = 'title'
  }
  if (!shapes.some((shape) => shape.role === 'subtitle')) {
    const title = shapes.find((shape) => shape.role === 'title')
    const subtitle = structuralCandidates
      .filter(
        (shape) =>
          !shape.role &&
          !isIndexText(shape.text) &&
          !isIconText(shape.text) &&
          (shape.text.length <= 70 || (shape.width >= 5_500_000 && shape.height <= 700_000)) &&
          (!title || shape.fontSize <= Math.max(24, title.fontSize * 0.82)) &&
          (!title || (shape.y >= title.y && Math.abs(shape.y - (title.y + title.height)) <= 1_350_000))
      )
      .sort((left, right) => subtitleCandidateScore(right, title) - subtitleCandidateScore(left, title))[0]
    if (subtitle) subtitle.role = 'subtitle'
  }
  usable.forEach((shape) => {
    if (!shape.role) shape.role = 'body'
  })
}

function isEditableTemplateShape(shape: TemplateShape) {
  const text = shape.text.trim()
  if (!text) return false
  if (/footer|页码|日期|logo|brand/i.test(shape.name)) return false
  if (shape.x > 11_000_000 && shape.y > 5_700_000 && equivalentTextLength(text) <= 8) return false
  if (shape.y > 6_050_000 && shape.fontSize <= 10 && /^[A-Z\s-]{10,}$/.test(text)) return false
  return true
}

function isStaleTemplateTopicLabel(text: string) {
  const normalized = text.trim()
  if (!normalized || normalized === 'ANNUAL REPORT') return false
  return /^[A-Z\s-]{16,}$/.test(normalized) || /(?:年度报告|年度监测|生态系统监测|项目数据汇总)/u.test(normalized)
}

function templateTitleScore(shape: TemplateShape) {
  const lengthPenalty = Math.max(0, equivalentTextLength(shape.text) - 52) * 18
  return shape.fontSize * 420 + Math.min(shape.width, 12_000_000) / 9_000 - shape.y / 900 - lengthPenalty
}

function subtitleCandidateScore(shape: TemplateShape, title: TemplateShape | undefined) {
  const distance = title ? Math.abs(shape.y - (title.y + title.height)) : shape.y
  const tooFarPenalty = title && distance > 1_350_000 ? 8_000 : 0
  return shape.fontSize * 220 + shape.width / 20_000 - distance / 700 - tooFarPenalty
}

function templateRoleShapeScore(shape: TemplateShape, role: Exclude<TemplateTextRole, 'body'>) {
  if (role === 'title') return templateTitleScore(shape)
  if (role === 'takeaway') return shape.width * shape.height + equivalentTextLength(shape.text) * 1_000_000
  return shape.fontSize * 220 - shape.y / 1_000 + shape.width / 20_000
}

function applyAdaptiveBodyContent(
  bodyShapes: TemplateShape[],
  bodyItems: string[],
  layout: string | undefined,
  warnings: string[]
) {
  const originalText = new Map(bodyShapes.map((shape) => [shape, shape.text]))
  bodyShapes.forEach((shape) => replaceTextBody(shape.textBody, [], 1500))
  if (bodyItems.length === 0) return

  const items = bodyItems.map(parseTemplateContentItem)
  const cohorts = collectTemplateShapeCohorts(bodyShapes)
  const capacity = inferTemplateItemCapacity(cohorts, bodyShapes)
  const repeated = cohorts.filter((cohort) => cohort.shapes.length >= 2 && capacity >= 2)
  if (repeated.length === 0) {
    const ordered = [...bodyShapes].sort(readingOrder)
    if (ordered.length === 1) {
      replaceTextBody(ordered[0].textBody, bodyItems, 1500, boundedTemplateFontSize(ordered[0], bodyItems, 'body'))
      return
    }
    bodyItems.slice(0, ordered.length).forEach((item, index) => {
      const parts = parseTemplateContentItem(item).visibleParts
      replaceTextBody(ordered[index].textBody, parts, 1500, boundedTemplateFontSize(ordered[index], parts, 'body'))
    })
    if (bodyItems.length > ordered.length && layout !== 'chart') {
      warnings.push(
        `${bodyItems.length - ordered.length} content item(s) could not fit this template page's ${ordered.length} editable text regions`
      )
    }
    return
  }

  const state = items.map((item) => ({
    detailIndex: 0,
    headingUsed: false,
    iconIndex: 0,
    valueUsed: false,
    item
  }))
  const hasHeadingCohort = repeated.some((cohort) => cohort.kind === 'heading')
  const orderedCohorts = [...repeated].sort((left, right) => cohortReadingOrder(left) - cohortReadingOrder(right))
  const assignedShapes = new Set<TemplateShape>()
  for (const cohort of orderedCohorts) {
    const shapes = [...cohort.shapes].sort(readingOrder)
    shapes.forEach((shape, index) => {
      assignedShapes.add(shape)
      const entry = state[index]
      if (!entry) return
      const value = contentForCohort(cohort.kind, entry, index, originalText.get(shape) || '', hasHeadingCohort)
      replaceTextBody(
        shape.textBody,
        value ? [value] : [],
        cohort.kind === 'metric' ? 2400 : 1500,
        boundedTemplateFontSize(shape, value ? [value] : [], cohort.kind === 'metric' ? 'metric' : 'body')
      )
    })
  }

  const anchorCohort =
    orderedCohorts.find((cohort) => cohort.shapes.length === capacity && cohort.kind === 'index') ||
    orderedCohorts.find((cohort) => cohort.shapes.length === capacity && cohort.kind === 'heading') ||
    orderedCohorts.find((cohort) => cohort.shapes.length === capacity)
  if (anchorCohort) {
    const anchors = [...anchorCohort.shapes].sort(readingOrder)
    const arrangement = inferTemplateArrangement(cohorts, capacity)
    bodyShapes
      .filter(
        (shape) =>
          !assignedShapes.has(shape) &&
          ['heading', 'detail', 'metric'].includes(classifyTemplateContentShape(shape)) &&
          isWithinTemplateSlotBand(shape, anchors, arrangement)
      )
      .sort(readingOrder)
      .forEach((shape) => {
        const itemIndex = nearestTemplateSlotIndex(shape, anchors, arrangement)
        const entry = state[itemIndex]
        if (!entry) return
        const kind = classifyTemplateContentShape(shape)
        const value = contentForCohort(kind, entry, itemIndex, originalText.get(shape) || '', hasHeadingCohort)
        replaceTextBody(
          shape.textBody,
          value ? [value] : [],
          kind === 'metric' ? 2400 : 1500,
          boundedTemplateFontSize(shape, value ? [value] : [], kind === 'metric' ? 'metric' : 'body')
        )
      })
  }

  if (items.length > capacity && layout !== 'chart') {
    warnings.push(`${items.length - capacity} content item(s) exceeded this template page's repeated-slot capacity`)
  }
}

function summarizeTemplateBulletHeadings(bullets: string[]) {
  if (bullets.length < 2) return undefined
  const headings = bullets.map((bullet) => parseTemplateContentItem(bullet).heading).filter(Boolean)
  if (headings.length < 2 || headings.length > 5) return undefined
  const summary = headings.join(' · ')
  return equivalentTextLength(summary) <= 80 ? summary : undefined
}

function isWithinTemplateSlotBand(shape: TemplateShape, anchors: TemplateShape[], arrangement: TemplateArrangement) {
  const minX = Math.min(...anchors.map((anchor) => anchor.x))
  const maxX = Math.max(...anchors.map((anchor) => anchor.x))
  const minY = Math.min(...anchors.map((anchor) => anchor.y))
  const maxY = Math.max(...anchors.map((anchor) => anchor.y))
  if (arrangement === 'list') return shape.y >= minY - 550_000 && shape.y <= maxY + 750_000
  if (arrangement === 'columns') return shape.x >= minX - 900_000 && shape.x <= maxX + 1_200_000
  return (
    shape.x >= minX - 900_000 && shape.x <= maxX + 1_200_000 && shape.y >= minY - 650_000 && shape.y <= maxY + 850_000
  )
}

function nearestTemplateSlotIndex(shape: TemplateShape, anchors: TemplateShape[], arrangement: TemplateArrangement) {
  let selectedIndex = 0
  let selectedDistance = Number.POSITIVE_INFINITY
  anchors.forEach((anchor, index) => {
    const xDistance = Math.abs(shape.x - anchor.x)
    const yDistance = Math.abs(shape.y - anchor.y)
    const distance =
      arrangement === 'list'
        ? yDistance + xDistance * 0.08
        : arrangement === 'columns'
          ? xDistance + yDistance * 0.04
          : Math.hypot(xDistance, yDistance)
    if (distance < selectedDistance) {
      selectedIndex = index
      selectedDistance = distance
    }
  })
  return selectedIndex
}

function collectTemplateShapeCohorts(shapes: TemplateShape[]): TemplateShapeCohort[] {
  const groups = new Map<string, TemplateShape[]>()
  for (const shape of shapes) {
    const kind = classifyTemplateContentShape(shape)
    const widthBucket = ['heading', 'icon', 'index', 'metric'].includes(kind) ? 0 : Math.round(shape.width / 320_000)
    const key = [kind, widthBucket, Math.round(shape.height / 130_000), Math.round(shape.fontSize)].join(':')
    const group = groups.get(key) || []
    group.push(shape)
    groups.set(key, group)
  }
  return [...groups.values()]
    .filter((group) => group.length >= 2 && group.length <= 8)
    .map((group) => ({ shapes: group, kind: classifyTemplateCohort(group) }))
}

function inferTemplateItemCapacity(cohorts: TemplateShapeCohort[], bodyShapes: TemplateShape[]) {
  const counts = new Map<number, number>()
  cohorts.forEach((cohort) => counts.set(cohort.shapes.length, (counts.get(cohort.shapes.length) || 0) + 1))
  const ranked = [...counts.entries()].sort((left, right) => right[1] * 10 + right[0] - (left[1] * 10 + left[0]))
  if (ranked.length > 0) return ranked[0][0]
  return Math.max(1, Math.min(6, bodyShapes.length))
}

function inferTemplateArrangement(cohorts: TemplateShapeCohort[], capacity: number): TemplateArrangement {
  const cohort =
    cohorts.find((item) => item.shapes.length === capacity && item.kind === 'heading') ||
    cohorts.find((item) => item.shapes.length === capacity && item.kind === 'detail') ||
    cohorts.find((item) => item.shapes.length === capacity)
  if (!cohort || cohort.shapes.length < 2) return 'free'
  const xGroups = clusterCoordinates(cohort.shapes.map((shape) => shape.x))
  const yGroups = clusterCoordinates(cohort.shapes.map((shape) => shape.y))
  if (xGroups >= 2 && yGroups >= 2) return 'grid'
  if (xGroups >= 2) return 'columns'
  if (yGroups >= 2) return 'list'
  return 'free'
}

function clusterCoordinates(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  let groups = 0
  let previous: number | undefined
  for (const value of sorted) {
    if (previous === undefined || Math.abs(value - previous) > 480_000) groups++
    previous = value
  }
  return groups
}

function classifyTemplateCohort(shapes: TemplateShape[]): TemplateContentKind {
  const kinds = shapes.map(classifyTemplateContentShape)
  const counts = new Map<TemplateContentKind, number>()
  kinds.forEach((kind) => counts.set(kind, (counts.get(kind) || 0) + 1))
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || 'detail'
}

function classifyTemplateContentShape(shape: TemplateShape): TemplateContentKind {
  if (isIndexText(shape.text)) return 'index'
  if (isIconText(shape.text)) return 'icon'
  if (isMetricText(shape.text) && shape.fontSize >= 18) return 'metric'
  if (equivalentTextLength(shape.text) <= 30 || (shape.fontSize >= 14 && shape.height <= 430_000)) return 'heading'
  return 'detail'
}

function parseTemplateContentItem(text: string): TemplateContentItem & { visibleParts: string[] } {
  const normalized = text.trim()
  let parts = normalized
    .split(/\s*\|\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 1) {
    const separator = normalized.match(/^(.{1,36}?)[：:]\s*(.+)$/u)
    if (separator) parts = [separator[1].trim(), separator[2].trim()]
  }
  const leadingMetric = parts[0]?.match(/^(-?\d[\d,.]*(?:\.\d+)?(?:%|万|亿|人|项|次|天|小时|只|km|m)?)\s+(.+)$/iu)
  if (leadingMetric) {
    const numericValue = Number(leadingMetric[1].replace(/[^\d.-]/g, ''))
    const looksLikeYear = /^\d{4}$/u.test(leadingMetric[1]) && numericValue >= 1900 && numericValue <= 2200
    if (!looksLikeYear) parts = [leadingMetric[2].trim(), leadingMetric[1], ...parts.slice(1)]
  }
  const heading = parts[0] || normalized
  const remaining = parts.slice(1)
  const valueIndex = remaining.findIndex((part) => /^-?\d[\d,.]*(?:\.\d+)?(?:%|万|亿|人|项|次|天|小时)?$/u.test(part))
  const value = valueIndex >= 0 ? remaining[valueIndex] : undefined
  const details = remaining.filter((_, index) => index !== valueIndex)
  return { heading, details, value, visibleParts: parts.length ? parts : [normalized] }
}

function contentForCohort(
  kind: TemplateContentKind,
  entry: {
    detailIndex: number
    headingUsed: boolean
    iconIndex: number
    valueUsed: boolean
    item: TemplateContentItem
  },
  index: number,
  sourceText: string,
  hasHeadingCohort: boolean
) {
  if (kind === 'index') return formatTemplateIndex(sourceText, index)
  if (kind === 'icon') {
    const visibleDetailCount = Math.max(1, entry.item.details.length + (entry.item.value ? 1 : 0))
    const visible = entry.iconIndex < visibleDetailCount
    entry.iconIndex++
    return visible ? '•' : ''
  }
  if (kind === 'metric') {
    entry.valueUsed = true
    return entry.item.value || ''
  }
  if (kind === 'heading') {
    if (!entry.headingUsed) {
      entry.headingUsed = true
      return entry.item.heading
    }
    const detail = entry.item.details[entry.detailIndex]
    if (detail) entry.detailIndex++
    return detail || ''
  }
  const detail = entry.item.details[entry.detailIndex]
  if (detail) {
    entry.detailIndex++
    return detail
  }
  if (!hasHeadingCohort && !entry.headingUsed) {
    entry.headingUsed = true
    return entry.item.heading
  }
  if (entry.item.value && !entry.valueUsed) {
    entry.valueUsed = true
    return entry.item.value
  }
  return ''
}

function formatTemplateIndex(source: string, index: number) {
  if (/chapter/i.test(source)) return `CHAPTER ${String(index + 1).padStart(2, '0')}`
  if (/^0\d+$/.test(source.trim())) return String(index + 1).padStart(source.trim().length, '0')
  return String(index + 1).padStart(2, '0')
}

function isIndexText(text: string) {
  return /^\s*(?:chapter\s*)?0?\d{1,3}(?:\s*[/|-]\s*\d{1,3})?\s*$/i.test(text)
}

function isIconText(text: string) {
  const normalized = text.replace(/\s/gu, '')
  return normalized.length > 0 && normalized.length <= 6 && !/[\p{L}\p{N}]/u.test(normalized)
}

function isMetricText(text: string) {
  return /^-?\d[\d,.]*(?:\.\d+)?(?:%|万|亿|人|项|次|天|小时|只|km|m)?$/iu.test(text.replace(/\s/gu, ''))
}

function equivalentTextLength(text: string) {
  return [...text].reduce((total, character) => total + ((character.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0)
}

function templateContentDensity(
  bodyTextUnits: number,
  itemCapacity: number,
  kind: TemplateLayoutKind
): 'sparse' | 'balanced' | 'dense' {
  if (kind === 'cover' || kind === 'section') return 'sparse'
  const unitsPerItem = bodyTextUnits / Math.max(1, itemCapacity)
  if (bodyTextUnits >= 300 || unitsPerItem >= 76) return 'dense'
  if (bodyTextUnits < 90 && unitsPerItem < 30) return 'sparse'
  return 'balanced'
}

function readingOrder(left: TemplateShape, right: TemplateShape) {
  const rowTolerance = Math.max(140_000, Math.min(left.height, right.height) * 0.45)
  if (Math.abs(left.y - right.y) <= rowTolerance) return left.x - right.x
  return left.y - right.y
}

function cohortReadingOrder(cohort: TemplateShapeCohort) {
  const first = [...cohort.shapes].sort(readingOrder)[0]
  return first.y / 10_000 + first.x / 100_000_000
}

function boundedTemplateFontSize(
  shape: TemplateShape,
  paragraphs: string[],
  role: Exclude<TemplateTextRole, 'body'> | 'body' | 'metric'
) {
  const length = equivalentTextLength(paragraphs.join(' '))
  if (role === 'title') {
    let maximum = length <= 24 ? 3600 : length <= 40 ? 3000 : length <= 58 ? 2400 : 2000
    if (shape.width < 5_000_000 || shape.height < 380_000) maximum = Math.min(maximum, 2400)
    return maximum
  }
  if (role === 'metric') return length <= 12 ? 2800 : 2200
  let maximum = length <= 24 ? 1800 : length <= 52 ? 1500 : length <= 90 ? 1200 : 1000
  if (shape.width < 1_700_000 || shape.height < 240_000) maximum = Math.min(maximum, 1200)
  return maximum
}

function applySingleRole(
  shapes: TemplateShape[],
  paragraphs: string[],
  role: Exclude<TemplateTextRole, 'body'>,
  updatedRoles: Set<TemplateTextRole>,
  warnings: string[]
) {
  if (shapes.length === 0) {
    if (paragraphs.length > 0 && role === 'title') warnings.push('no title placeholder or safe title shape was found')
    return
  }
  const ordered = [...shapes].sort(
    (left, right) => templateRoleShapeScore(right, role) - templateRoleShapeScore(left, role)
  )
  replaceTextBody(
    ordered[0].textBody,
    paragraphs,
    role === 'title' ? 2800 : 1700,
    boundedTemplateFontSize(ordered[0], paragraphs, role)
  )
  ordered.slice(1).forEach((shape) => replaceTextBody(shape.textBody, [], 1600))
  updatedRoles.add(role)
}

function replaceTextBody(
  textBody: OrderedXmlNode,
  paragraphs: string[],
  fallbackFontSize: number,
  maximumFontSize?: number
): void {
  const bodyChildren = elementChildren(textBody, 'p:txBody')
  const bodyProperties = findOrderedElement(bodyChildren, 'a:bodyPr')
  if (bodyProperties) ensureBoundedAutofit(bodyProperties)
  const paragraphIndices = bodyChildren
    .map((node, index) => (Object.hasOwn(node, 'a:p') ? index : -1))
    .filter((index) => index >= 0)
  const template =
    paragraphIndices.length > 0 ? cloneOrderedNode(bodyChildren[paragraphIndices[0]]) : createParagraph('')
  const replacements = (paragraphs.length ? paragraphs : ['']).map((text) => {
    const paragraph = cloneOrderedNode(template)
    setParagraphText(paragraph, text, fallbackFontSize, maximumFontSize)
    return paragraph
  })
  if (paragraphIndices.length === 0) {
    bodyChildren.push(...replacements)
    return
  }
  const first = paragraphIndices[0]
  for (let index = paragraphIndices.length - 1; index >= 0; index--) bodyChildren.splice(paragraphIndices[index], 1)
  bodyChildren.splice(first, 0, ...replacements)
}

function setParagraphText(
  paragraph: OrderedXmlNode,
  text: string,
  fallbackFontSize: number,
  maximumFontSize?: number
): void {
  const textNodes: OrderedXmlNode[] = []
  walkOrdered([paragraph], (node) => {
    if (Object.hasOwn(node, 'a:t')) textNodes.push(node)
    if (Object.hasOwn(node, 'a:rPr') || Object.hasOwn(node, 'a:defRPr') || Object.hasOwn(node, 'a:endParaRPr')) {
      const size = orderedAttribute(node, 'sz')
      if (!size) setOrderedAttribute(node, 'sz', String(fallbackFontSize))
      else if (maximumFontSize && Number(size) > maximumFontSize) {
        setOrderedAttribute(node, 'sz', String(maximumFontSize))
      }
    }
  })
  if (textNodes.length === 0) {
    const children = elementChildren(paragraph, 'a:p')
    const run: OrderedXmlNode = {
      'a:r': [
        { 'a:rPr': [], ':@': { '@_lang': 'zh-CN', '@_sz': String(fallbackFontSize) } },
        { 'a:t': [{ '#text': text }] }
      ]
    }
    const endIndex = children.findIndex((node) => Object.hasOwn(node, 'a:endParaRPr'))
    children.splice(endIndex >= 0 ? endIndex : children.length, 0, run)
    return
  }
  setOrderedText(textNodes[0], text)
  textNodes.slice(1).forEach((node) => setOrderedText(node, ''))
}

function ensureBoundedAutofit(bodyProperties: OrderedXmlNode): void {
  const attributes = bodyProperties[':@']
  if (attributes && typeof attributes === 'object') {
    delete (attributes as Record<string, unknown>)['@_vertOverflow']
  }
  const children = elementChildren(bodyProperties, 'a:bodyPr')
  for (let index = children.length - 1; index >= 0; index--) {
    if (Object.hasOwn(children[index], 'a:spAutoFit') || Object.hasOwn(children[index], 'a:noAutofit')) {
      children.splice(index, 1)
    }
  }
  if (!children.some((node) => Object.hasOwn(node, 'a:normAutofit'))) children.push({ 'a:normAutofit': [] })
}

function createParagraph(text: string): OrderedXmlNode {
  return {
    'a:p': [
      {
        'a:r': [{ 'a:rPr': [], ':@': { '@_lang': 'zh-CN', '@_sz': '1600' } }, { 'a:t': [{ '#text': text }] }]
      }
    ]
  }
}

function matchesReplacement(shape: TemplateShape, replacement: PptxTemplateShapeReplacement): boolean {
  const shapeName = replacement.shape_name?.trim().toLowerCase()
  const findText = replacement.find_text?.trim().toLowerCase()
  if (!shapeName && !findText) return false
  return Boolean(
    (!shapeName || shape.name.trim().toLowerCase() === shapeName) &&
      (!findText || shape.text.trim().toLowerCase().includes(findText))
  )
}

function normalizeReplacements(input: PptxTemplateShapeReplacement[] | undefined) {
  if (!Array.isArray(input)) return []
  return input
    .map((item) => ({
      slide_number: item.slide_number,
      shape_name: item.shape_name?.trim() || undefined,
      find_text: item.find_text?.trim() || undefined,
      text: typeof item.text === 'string' ? item.text : ''
    }))
    .filter((item) => (item.shape_name || item.find_text) && typeof item.text === 'string')
}

function stripSlideLocalRelationships(source: string): string {
  return source.replace(
    /<Relationship\b(?=[^>]*\bType="[^"]*\/(?:notesSlide|comments|threadedComment)")[^>]*(?:\/>|>\s*<\/Relationship>)/g,
    ''
  )
}

function replaceDominantTemplatePicture(
  zip: AdmZip,
  slideXml: string,
  relationshipsXml: string,
  asset: LoadedImageAsset,
  outputSlideNumber: number
): { relationships: string; warnings: string[] } {
  const relationshipId = dominantPictureRelationshipId(slideXml)
  if (!relationshipId) {
    throw new Error('no picture shape was found; image_asset_id can only replace a source page that contains a picture')
  }
  if (!relationshipsXml) throw new Error('template picture slide is missing its relationship part')

  const relationships = orderedParser.parse(relationshipsXml) as OrderedXmlNode[]
  let matched = false
  walkOrdered(relationships, (node) => {
    if (!Object.hasOwn(node, 'Relationship') || orderedAttribute(node, 'Id') !== relationshipId) return
    const mediaName = `zen-ai-template-${outputSlideNumber}.png`
    setOrderedAttribute(node, 'Target', `../media/${mediaName}`)
    zip.addFile(`ppt/media/${mediaName}`, asset.data)
    ensurePngContentType(zip)
    matched = true
  })
  if (!matched) throw new Error(`template picture relationship '${relationshipId}' was not found`)
  return { relationships: orderedBuilder.build(relationships), warnings: [] }
}

function ensureTemplatePictureTextContrast(slideXml: string): { xml: string; warnings: string[] } {
  if (slideXml.includes('Zen AI adaptive contrast overlay')) return { xml: slideXml, warnings: [] }
  const picture = dominantPictureGeometry(slideXml)
  if (
    !picture ||
    picture.x > 120_000 ||
    picture.y > 120_000 ||
    picture.width < 8_500_000 ||
    picture.height < 4_700_000
  ) {
    return { xml: slideXml, warnings: [] }
  }
  const document = orderedParser.parse(slideXml) as OrderedXmlNode[]
  const colors: string[] = []
  let maximumShapeId = 1000
  walkOrdered(document, (node) => {
    if (Object.hasOwn(node, 'p:cNvPr')) {
      maximumShapeId = Math.max(maximumShapeId, Number(orderedAttribute(node, 'id') || 0))
    }
    if (Object.hasOwn(node, 'a:srgbClr')) {
      const value = orderedAttribute(node, 'val')
      if (value && /^[0-9a-f]{6}$/i.test(value)) colors.push(value)
    }
  })
  const averageLuminance = colors.length
    ? colors.reduce((total, color) => total + colorLuminance(color), 0) / colors.length
    : 0.8
  const overlayColor = averageLuminance >= 0.56 ? '000000' : 'FFFFFF'
  const opacity = averageLuminance >= 0.56 ? 26_000 : 30_000
  const overlay = `<p:sp><p:nvSpPr><p:cNvPr id="${maximumShapeId + 1}" name="Zen AI adaptive contrast overlay"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${picture.width}" cy="${picture.height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${overlayColor}"><a:alpha val="${opacity}"/></a:srgbClr></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`
  const relationshipPattern = escapeRegularExpression(picture.relationshipId)
  const picturePattern = new RegExp(
    `(<p:pic(?:\\s[^>]*)?>[\\s\\S]*?<a:blip[^>]*\\br:embed="${relationshipPattern}"[^>]*>[\\s\\S]*?<\\/p:pic>)`
  )
  if (!picturePattern.test(slideXml)) return { xml: slideXml, warnings: [] }
  return {
    xml: slideXml.replace(picturePattern, `$1${overlay}`),
    warnings: ['added a subtle adaptive contrast overlay after replacing a full-bleed template picture']
  }
}

function dominantPictureGeometry(slideXml: string) {
  const document = orderedParser.parse(slideXml) as OrderedXmlNode[]
  let selected:
    | { relationshipId: string; x: number; y: number; width: number; height: number; area: number }
    | undefined
  walkOrdered(document, (node) => {
    if (!Object.hasOwn(node, 'p:pic')) return
    const children = elementChildren(node, 'p:pic')
    const blip = findOrderedElement(children, 'a:blip')
    const offset = findOrderedElement(children, 'a:off')
    const extent = findOrderedElement(children, 'a:ext')
    const relationshipId = orderedAttribute(blip, 'r:embed')
    if (!relationshipId) return
    const width = orderedNumber(extent, 'cx')
    const height = orderedNumber(extent, 'cy')
    const area = width * height
    if (!selected || area > selected.area) {
      selected = {
        relationshipId,
        x: orderedNumber(offset, 'x'),
        y: orderedNumber(offset, 'y'),
        width,
        height,
        area
      }
    }
  })
  return selected
}

function colorLuminance(color: string) {
  const channels = [0, 2, 4].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function updateTemplateChartData(
  zip: AdmZip,
  slideXml: string,
  relationshipsXml: string,
  slide: PptxTemplateSlide,
  outputSlideNumber: number
): { relationships: string; warnings: string[] } {
  const data = templateChartData(slide)
  const chartRelationshipIds = [...slideXml.matchAll(/<c:chart\b[^>]*\br:id="([^"]+)"/g)].map((match) => match[1])
  if (chartRelationshipIds.length === 0) return { relationships: relationshipsXml, warnings: [] }
  if (data.length < 2) {
    throw new Error(
      'a native chart page was selected without at least two new-topic numeric data points; choose a non-chart template page or provide label:value bullets and retry automatically'
    )
  }

  const relationships = orderedParser.parse(relationshipsXml) as OrderedXmlNode[]
  let updatedCharts = 0
  walkOrdered(relationships, (node) => {
    if (!Object.hasOwn(node, 'Relationship')) return
    const relationshipId = orderedAttribute(node, 'Id')
    if (!relationshipId || !chartRelationshipIds.includes(relationshipId)) return
    const target = orderedAttribute(node, 'Target')
    if (!target) return
    const sourcePart = resolveRelationshipTarget('ppt/slides/slide1.xml', target)
    const sourceChart = zip.readAsText(sourcePart)
    if (!sourceChart) return
    const chartIndex = updatedCharts + 1
    const newPart = `ppt/charts/zen-ai-template-chart-${outputSlideNumber}-${chartIndex}.xml`
    zip.addFile(newPart, Buffer.from(rewriteTemplateChartXml(sourceChart, slide, data), 'utf-8'))
    cloneChartRelationships(zip, sourcePart, newPart)
    ensureChartContentType(zip, newPart)
    setOrderedAttribute(node, 'Target', `../charts/${path.posix.basename(newPart)}`)
    updatedCharts++
  })
  if (updatedCharts === 0) throw new Error('native chart relationship could not be resolved')
  return {
    relationships: orderedBuilder.build(relationships),
    warnings: [`updated ${updatedCharts} native chart(s) with ${data.length} new-topic data points`]
  }
}

function templateChartData(slide: PptxTemplateSlide) {
  return slide.bullets
    .map((bullet) => {
      const parts = bullet.split(/\s*[|：:]\s*/).filter(Boolean)
      const numericPart = [...parts].reverse().find((part) => /-?\d[\d,.]*(?:\.\d+)?/.test(part)) || bullet
      const match = numericPart.match(/-?\d[\d,.]*(?:\.\d+)?/)
      if (!match) return undefined
      const value = Number(match[0].replace(/,/g, ''))
      if (!Number.isFinite(value)) return undefined
      const label = (parts.find((part) => part !== numericPart) || bullet.replace(match[0], '')).trim()
      return { label: label || `Item ${parts.length + 1}`, value }
    })
    .filter((item): item is { label: string; value: number } => Boolean(item))
    .slice(0, 12)
}

export function rewriteTemplateChartXml(
  source: string,
  slide: PptxTemplateSlide,
  data: Array<{ label: string; value: number }>
) {
  let keptSeries = false
  const rewritten = source.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (series) => {
    if (keptSeries) return ''
    keptSeries = true
    let updated = series
    const title = escapeXmlText(slide.subtitle || slide.title)
    updated = updateChartSeriesTitle(updated, title)
    updated = updateChartReferenceCache(
      updated,
      'c:cat',
      'c:strCache',
      data.map((item) => escapeXmlText(item.label)),
      undefined
    )
    updated = updateChartReferenceCache(
      updated,
      'c:val',
      'c:numCache',
      data.map((item) => String(item.value)),
      'General'
    )
    return updated
  })
  return rewritten.replace(/<c:valAx>[\s\S]*?<\/c:valAx>/g, (axis) =>
    axis
      .replace(/<c:min\b[^>]*(?:\/>|>\s*<\/c:min>)/g, '')
      .replace(/<c:max\b[^>]*(?:\/>|>\s*<\/c:max>)/g, '')
      .replace(/<c:majorUnit\b[^>]*(?:\/>|>\s*<\/c:majorUnit>)/g, '')
  )
}

function updateChartSeriesTitle(series: string, title: string) {
  const cache = `<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${title}</c:v></c:pt></c:strCache>`
  if (/<c:tx>[\s\S]*?<c:strCache>[\s\S]*?<\/c:strCache>[\s\S]*?<\/c:tx>/.test(series)) {
    return series.replace(/<c:strCache>[\s\S]*?<\/c:strCache>/, cache)
  }
  if (/<c:tx>[\s\S]*?<c:v>[\s\S]*?<\/c:v>[\s\S]*?<\/c:tx>/.test(series)) {
    return series.replace(/(<c:tx>[\s\S]*?<c:v>)[\s\S]*?(<\/c:v>[\s\S]*?<\/c:tx>)/, `$1${title}$2`)
  }
  return series
}

function updateChartReferenceCache(
  series: string,
  wrapperTag: 'c:cat' | 'c:val',
  cacheTag: 'c:strCache' | 'c:numCache',
  values: string[],
  formatCode: string | undefined
) {
  const wrapperPattern = new RegExp(`<${wrapperTag}>[\\s\\S]*?<\\/${wrapperTag}>`)
  const wrapper = series.match(wrapperPattern)?.[0]
  if (!wrapper) return series
  const cachePattern = new RegExp(`<${cacheTag}>[\\s\\S]*?<\\/${cacheTag}>`)
  const cache = `<${cacheTag}>${formatCode ? `<c:formatCode>${formatCode}</c:formatCode>` : ''}<c:ptCount val="${values.length}"/>${values
    .map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`)
    .join('')}</${cacheTag}>`
  let updatedWrapper = cachePattern.test(wrapper) ? wrapper.replace(cachePattern, cache) : wrapper
  updatedWrapper = updatedWrapper.replace(
    /(<c:f>[^<]*\$[A-Z]+\$\d+:\$[A-Z]+\$)\d+(<\/c:f>)/,
    `$1${values.length + 1}$2`
  )
  return series.replace(wrapperPattern, updatedWrapper)
}

function cloneChartRelationships(zip: AdmZip, sourcePart: string, targetPart: string) {
  const sourceRelationships = path.posix.join(
    path.posix.dirname(sourcePart),
    '_rels',
    `${path.posix.basename(sourcePart)}.rels`
  )
  const targetRelationships = path.posix.join(
    path.posix.dirname(targetPart),
    '_rels',
    `${path.posix.basename(targetPart)}.rels`
  )
  const relationships = zip.readFile(sourceRelationships)
  if (relationships) zip.addFile(targetRelationships, relationships)
}

function ensureChartContentType(zip: AdmZip, chartPart: string) {
  const source = zip.readAsText('[Content_Types].xml')
  const partName = `/${chartPart}`
  if (!source || source.includes(`PartName="${partName}"`)) return
  const override = `<Override PartName="${partName}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`
  zip.updateFile('[Content_Types].xml', Buffer.from(source.replace('</Types>', `${override}</Types>`), 'utf-8'))
}

function escapeXmlText(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dominantPictureRelationshipId(slideXml: string): string | undefined {
  const document = orderedParser.parse(slideXml) as OrderedXmlNode[]
  let selected: { id: string; area: number } | undefined
  walkOrdered(document, (node) => {
    if (!Object.hasOwn(node, 'p:pic')) return
    const children = elementChildren(node, 'p:pic')
    const blip = findOrderedElement(children, 'a:blip')
    const extent = findOrderedElement(children, 'a:ext')
    const id = orderedAttribute(blip, 'r:embed')
    if (!id) return
    const area = orderedNumber(extent, 'cx') * orderedNumber(extent, 'cy')
    if (!selected || area > selected.area) selected = { id, area }
  })
  return selected?.id
}

function ensurePngContentType(zip: AdmZip): void {
  const source = zip.readAsText('[Content_Types].xml')
  if (!source || /<Default\b[^>]*\bExtension="png"/i.test(source)) return
  zip.updateFile(
    '[Content_Types].xml',
    Buffer.from(source.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>'), 'utf-8')
  )
}

function slideRelationshipPart(slidePart: string) {
  return path.posix.join(path.posix.dirname(slidePart), '_rels', `${path.posix.basename(slidePart)}.rels`)
}

function resolveRelationshipTarget(sourcePart: string, target: string) {
  const normalized = target.replace(/\\/g, '/')
  return normalized.startsWith('/')
    ? path.posix.normalize(normalized.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), normalized))
}

function normalizeSlideNumber(value: number, count: number, field: string) {
  if (!Number.isInteger(value) || value < 1 || value > count) {
    throw new Error(`${field} must be an integer between 1 and ${count}`)
  }
  return value
}

function nextRelationshipId(used: Set<number>) {
  let number = 1
  while (used.has(number)) number++
  used.add(number)
  return `rId${number}`
}

function countParts(zip: AdmZip, pattern: RegExp) {
  return zip.getEntries().filter((entry) => !entry.isDirectory && pattern.test(entry.entryName)).length
}

function findOrderedElement(nodes: OrderedXmlNode[], tagName: string): OrderedXmlNode | undefined {
  for (const node of nodes) {
    if (Object.hasOwn(node, tagName)) return node
    for (const [key, value] of Object.entries(node)) {
      if (key !== ':@' && Array.isArray(value)) {
        const found = findOrderedElement(value as OrderedXmlNode[], tagName)
        if (found) return found
      }
    }
  }
  return undefined
}

function elementChildren(node: OrderedXmlNode | undefined, tagName: string): OrderedXmlNode[] {
  const value = node?.[tagName]
  return Array.isArray(value) ? (value as OrderedXmlNode[]) : []
}

function walkOrdered(nodes: OrderedXmlNode[], visit: (node: OrderedXmlNode) => void): void {
  for (const node of nodes) {
    visit(node)
    for (const [key, value] of Object.entries(node)) {
      if (key !== ':@' && Array.isArray(value)) walkOrdered(value as OrderedXmlNode[], visit)
    }
  }
}

function collectOrderedText(nodes: OrderedXmlNode[]): string {
  const values: string[] = []
  walkOrdered(nodes, (node) => {
    if (!Object.hasOwn(node, 'a:t')) return
    const children = elementChildren(node, 'a:t')
    const text = children
      .map((child) => child['#text'])
      .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
      .join('')
    if (text.trim()) values.push(text.trim())
  })
  return values.join(' ')
}

function largestFontSize(nodes: OrderedXmlNode[]) {
  let size = 0
  walkOrdered(nodes, (node) => {
    if (!Object.hasOwn(node, 'a:rPr') && !Object.hasOwn(node, 'a:defRPr')) return
    const parsed = Number(orderedAttribute(node, 'sz'))
    if (Number.isFinite(parsed)) size = Math.max(size, parsed / 100)
  })
  return size
}

function orderedAttribute(node: OrderedXmlNode | undefined, name: string): string | undefined {
  const attributes = node?.[':@']
  if (!attributes || typeof attributes !== 'object') return undefined
  const value = (attributes as Record<string, unknown>)[`@_${name}`]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function setOrderedAttribute(node: OrderedXmlNode, name: string, value: string): void {
  const attributes = node[':@']
  const normalized = attributes && typeof attributes === 'object' ? attributes : {}
  ;(normalized as Record<string, unknown>)[`@_${name}`] = value
  node[':@'] = normalized
}

function orderedNumber(node: OrderedXmlNode | undefined, name: string) {
  const parsed = Number(orderedAttribute(node, name))
  return Number.isFinite(parsed) ? parsed : 0
}

function setOrderedText(node: OrderedXmlNode, value: string) {
  const children = elementChildren(node, 'a:t')
  if (children.length === 0) {
    node['a:t'] = [{ '#text': value }]
    return
  }
  const textNode = children.find((child) => Object.hasOwn(child, '#text')) || children[0]
  textNode['#text'] = value
}

function cloneOrderedNode<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function uniqueNumbers(values: number[]) {
  return [...new Set(values)].sort((left, right) => left - right)
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)]
}
