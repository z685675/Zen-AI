import fsp from 'node:fs/promises'
import path from 'node:path'

import AdmZip from 'adm-zip'
import { XMLParser } from 'fast-xml-parser'
import sharp from 'sharp'

import type {
  BrandThemeInput,
  ResolvedDocumentStyle,
  ResolvedDocumentStyleMode,
  VisualStyleId
} from './assistantDocumentStyles'

const MAX_REFERENCE_BYTES = 100 * 1024 * 1024
const MAX_ANALYZED_SLIDES = 30
const IMAGE_EXTENSIONS = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'])
const WIDE_ASPECT_RATIO = 16 / 9

type XmlRecord = Record<string, unknown>

export interface PptxStyleReferenceInput {
  file_path?: string
  slide_number?: number
}

export interface PptxStyleReferenceProfile {
  kind: 'pptx' | 'image'
  sourcePath: string
  slideCount: number
  analyzedSlide?: number
  width: number
  height: number
  aspectRatio: number
  aspectRatioCompatible: boolean
  suggestedVisualStyle: VisualStyleId
  suggestedMode: ResolvedDocumentStyleMode
  layoutConfidence: 'high' | 'medium' | 'low'
  primaryColor: string
  secondaryColor: string
  accentColor: string
  backgroundColor: string
  headingFont?: string
  bodyFont?: string
  eastAsiaFont?: string
  metrics: {
    averageFilledShapes: number
    averageLineShapes: number
    averageEllipseShapes: number
    averageRectShapes: number
    averageRoundedShapes: number
    averageLargeColorFields: number
    averagePictureCoverage: number
    pictureSlideRatio: number
    chartSlideRatio: number
    averageTextBlocks: number
    averageTextUnits: number
    averageLargestFontPoints: number
    centeredTextRatio: number
    denseTextSlideRatio: number
    darkSlideRatio: number
    nativeLayoutCount: number
    nativeLayoutDiversityRatio: number
    visualLayoutDiversityRatio: number
    numericTextRatio: number
  }
  composition: {
    slides: PptxReferenceSlidePattern[]
  }
  imageAnalysis?: PptxReferenceImageAnalysis
  designLanguage: PptxDesignLanguageProfile
  warnings: string[]
}

export type PptxContentDensity = 'sparse' | 'balanced' | 'dense'

export interface PptxDesignLanguageProfile {
  paletteStrategy: 'monochrome' | 'single-accent' | 'multi-accent'
  contrast: 'soft' | 'balanced' | 'high'
  typographyScale: 'compact' | 'balanced' | 'display'
  alignment: 'left-led' | 'centered' | 'mixed'
  shapeLanguage: 'open' | 'linear' | 'rectilinear' | 'rounded' | 'circular' | 'mixed'
  contentDensity: PptxContentDensity
  imageTreatment: 'none' | 'full-bleed' | 'framed' | 'mixed'
  pageRhythm: 'quiet' | 'alternating' | 'evidence-led' | 'editorial'
  compositionBias: 'centered' | 'left-led' | 'right-led' | 'top-led' | 'bottom-led' | 'balanced'
  spatialRhythm: 'spacious' | 'balanced' | 'compact'
  decorationDensity: 'minimal' | 'restrained' | 'rich'
  surfaceTreatment: 'flat' | 'layered' | 'textured' | 'photographic' | 'mixed'
  targets: {
    minimumTextDensityRatio: number
    maximumTextDensityRatio: number
    minimumLayoutDiversityRatio: number
    pictureSlideRatio: number
    chartSlideRatio: number
    darkSlideRatio: number
  }
}

export interface PptxReferenceImageAnalysis {
  activeContentRatio: number
  activeBoundsWidthRatio: number
  activeBoundsHeightRatio: number
  centroidX: number
  centroidY: number
  leftVisualWeight: number
  rightVisualWeight: number
  topVisualWeight: number
  bottomVisualWeight: number
  edgeDensity: number
  textureScore: number
  photographicCoverage: number
}

export type PptxReferenceSlideArchetype =
  | 'full-bleed-image'
  | 'photo-chapter'
  | 'image-text'
  | 'chart-report'
  | 'dense-report'
  | 'open-report'

export type PptxReferencePicturePlacement = 'none' | 'full' | 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface PptxReferenceSlidePattern {
  slideNumber: number
  archetype: PptxReferenceSlideArchetype
  dark: boolean
  pictureCoverage: number
  picturePlacement: PptxReferencePicturePlacement
  chartCount: number
  textBlocks: number
  textUnits: number
  density: PptxContentDensity
}

export interface PptxReferenceSimilarityResult {
  score: number
  level: 'high' | 'medium' | 'low'
  warnings: string[]
  errors: string[]
  details: Record<string, number | string | boolean>
}

interface ThemeProfile {
  colors: Record<string, string>
  headingFont?: string
  bodyFont?: string
  eastAsiaFont?: string
}

interface SlideVisualMetrics {
  backgroundColor: string
  filledShapes: number
  lineShapes: number
  ellipseShapes: number
  rectShapes: number
  roundedShapes: number
  largeColorFields: number
  pictureCoverage: number
  largestPictureCoverage: number
  picturePlacement: PptxReferencePicturePlacement
  chartCount: number
  numericText: number
  textBlocks: number
  textUnits: number
  largestFontPoints: number
  centeredTextBlocks: number
  averageTextCenterX: number
  averageTextCenterY: number
  colorCounts: Map<string, number>
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  removeNSPrefix: true,
  trimValues: true
})

export async function analyzePptxStyleReference(
  filePath: string,
  requestedSlide?: number
): Promise<PptxStyleReferenceProfile> {
  const extension = path.extname(filePath).toLowerCase()
  const stat = await fsp.stat(filePath)
  if (!stat.isFile()) throw new Error(`PPT style reference is not a file: ${filePath}`)
  if (stat.size > MAX_REFERENCE_BYTES) throw new Error('PPT style reference exceeds the 100 MB limit')

  if (extension === '.pptx') {
    return analyzePptxBuffer(await fsp.readFile(filePath), filePath, requestedSlide)
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    if (requestedSlide !== undefined) throw new Error('slide_number is only valid for a PPTX style reference')
    return await analyzeReferenceImage(filePath)
  }
  throw new Error('PPT style reference must be a .pptx file or a supported image')
}

export function analyzePptxBuffer(
  buffer: Buffer,
  sourcePath = 'reference.pptx',
  requestedSlide?: number
): PptxStyleReferenceProfile {
  const zip = new AdmZip(buffer)
  const presentationXml = zip.readAsText('ppt/presentation.xml')
  if (!presentationXml) throw new Error('Reference PPTX is missing ppt/presentation.xml')

  const slideParts = zip
    .getEntries()
    .map((entry) => entry.entryName)
    .filter((entryName) => /^ppt\/slides\/slide\d+\.xml$/.test(entryName))
    .sort((left, right) => slidePartNumber(left) - slidePartNumber(right))
  if (slideParts.length === 0) throw new Error('Reference PPTX contains no slides')

  const selectedSlide = normalizeRequestedSlide(requestedSlide, slideParts.length)
  const analyzedParts = slideParts.slice(0, MAX_ANALYZED_SLIDES)
  const representativePart = selectedSlide ? slideParts[selectedSlide - 1] : analyzedParts[0]
  const presentation = parseXml(presentationXml)
  const slideSize = child(child(presentation, 'presentation'), 'sldSz')
  const width = positiveNumber(slideSize?.cx) || 9_144_000
  const height = positiveNumber(slideSize?.cy) || 5_143_500
  const theme = readThemeProfile(zip, representativePart)
  const slideMetrics = analyzedParts.map((partName) =>
    analyzeSlideXml(
      zip.readAsText(partName),
      width,
      height,
      theme.colors,
      readInheritedSlideBackground(zip, partName, theme.colors) || theme.colors.lt1 || 'FFFFFF'
    )
  )
  const nativeLayoutCount = new Set(
    analyzedParts.map((partName) => relatedPart(zip, partName, 'slideLayout')).filter(Boolean)
  ).size
  const aggregate = aggregateSlideMetrics(slideMetrics, nativeLayoutCount)
  const representativeMetrics = selectedSlide
    ? analyzeSlideXml(
        zip.readAsText(representativePart),
        width,
        height,
        theme.colors,
        readInheritedSlideBackground(zip, representativePart, theme.colors) || theme.colors.lt1 || 'FFFFFF'
      )
    : undefined
  const paletteMetrics = representativeMetrics ? aggregateSlideMetrics([representativeMetrics]) : aggregate
  const backgroundCounts = new Map<string, number>()
  slideMetrics.forEach((metrics) => incrementColor(backgroundCounts, metrics.backgroundColor))
  const backgroundColor = mostCommonColor(backgroundCounts, theme.colors.lt1 || 'FFFFFF')
  const palette = selectPalette(paletteMetrics.colorCounts, backgroundColor, [
    theme.colors.accent1,
    theme.colors.accent2,
    theme.colors.accent3
  ])
  // A representative page may influence palette and typography, but a dark cover must not turn the whole deck dark.
  const suggestedMode: ResolvedDocumentStyleMode =
    slideMetrics.filter((metrics) => colorLuminance(metrics.backgroundColor) < 0.34).length > slideMetrics.length / 2
      ? 'dark'
      : 'light'
  const suggestedVisualStyle = suggestVisualStyle(aggregate, palette, suggestedMode)
  const designLanguage = deriveDesignLanguage(aggregate.metrics, slideMetrics, palette, backgroundColor)
  const aspectRatio = width / height
  const warnings = [
    ...(Math.abs(aspectRatio - WIDE_ASPECT_RATIO) > 0.08
      ? ['Reference aspect ratio differs from 16:9; colors and layout language are inherited, but output remains 16:9.']
      : []),
    ...(selectedSlide
      ? []
      : [
          'No slide_number was provided; the profile aggregates up to the first 12 slides instead of cloning one layout.'
        ])
  ]

  return {
    kind: 'pptx',
    sourcePath,
    slideCount: slideParts.length,
    analyzedSlide: selectedSlide,
    width,
    height,
    aspectRatio: round(aspectRatio),
    aspectRatioCompatible: Math.abs(aspectRatio - WIDE_ASPECT_RATIO) <= 0.08,
    suggestedVisualStyle,
    suggestedMode,
    layoutConfidence: selectedSlide ? 'high' : 'medium',
    primaryColor: palette[0],
    secondaryColor: palette[1],
    accentColor: palette[2],
    backgroundColor,
    headingFont: theme.headingFont,
    bodyFont: theme.bodyFont,
    eastAsiaFont: theme.eastAsiaFont,
    metrics: aggregate.metrics,
    composition: {
      slides: slideMetrics.map((metrics, index) => referenceSlidePattern(metrics, index + 1))
    },
    designLanguage,
    warnings
  }
}

export function referenceBrandTheme(
  profile: PptxStyleReferenceProfile,
  explicitTheme?: BrandThemeInput
): BrandThemeInput {
  return {
    name: explicitTheme?.name || `Reference: ${path.basename(profile.sourcePath)}`,
    primary_color: explicitTheme?.primary_color || profile.primaryColor,
    secondary_color: explicitTheme?.secondary_color || profile.secondaryColor,
    accent_color: explicitTheme?.accent_color || profile.accentColor
  }
}

export function applyPptxReferenceFonts(
  style: ResolvedDocumentStyle,
  profile: PptxStyleReferenceProfile,
  keepExplicitSource: boolean
): ResolvedDocumentStyle {
  return {
    ...style,
    source: keepExplicitSource ? style.source : 'reference',
    headingFont: profile.headingFont || style.headingFont,
    bodyFont: profile.bodyFont || style.bodyFont,
    eastAsiaFont: profile.eastAsiaFont || style.eastAsiaFont
  }
}

export function pptxReferenceSummary(profile: PptxStyleReferenceProfile) {
  return {
    kind: profile.kind,
    source_path: profile.sourcePath,
    slide_count: profile.slideCount,
    analyzed_slide: profile.analyzedSlide,
    aspect_ratio: profile.aspectRatio,
    aspect_ratio_compatible: profile.aspectRatioCompatible,
    suggested_visual_style: profile.suggestedVisualStyle,
    suggested_mode: profile.suggestedMode,
    layout_confidence: profile.layoutConfidence,
    primary_color: profile.primaryColor,
    secondary_color: profile.secondaryColor,
    accent_color: profile.accentColor,
    background_color: profile.backgroundColor,
    heading_font: profile.headingFont,
    body_font: profile.bodyFont,
    east_asia_font: profile.eastAsiaFont,
    ...profile.metrics,
    composition: profile.composition,
    image_analysis: profile.imageAnalysis,
    design_language: profile.designLanguage,
    warnings: profile.warnings
  }
}

export function isImageHeavyPptxReference(profile: PptxStyleReferenceProfile) {
  if (profile.kind !== 'pptx') return false
  return (
    profile.metrics.averagePictureCoverage >= 0.28 ||
    (profile.metrics.pictureSlideRatio >= 0.4 && profile.metrics.averagePictureCoverage >= 0.12)
  )
}

export function comparePptxReferenceComposition(
  reference: PptxStyleReferenceProfile,
  output: PptxStyleReferenceProfile,
  semanticLayouts: string[] = []
): PptxReferenceSimilarityResult {
  const warnings: string[] = []
  const errors: string[] = []
  const semanticChartRatio = semanticLayouts.length
    ? semanticLayouts.filter((layout) => layout.trim().toLowerCase() === 'chart').length / semanticLayouts.length
    : 0
  const outputPictureRatio = output.metrics.pictureSlideRatio
  const outputChartRatio = Math.max(output.metrics.chartSlideRatio, semanticChartRatio)
  const referenceDiversity = Math.max(
    reference.metrics.nativeLayoutDiversityRatio,
    reference.metrics.visualLayoutDiversityRatio
  )
  const outputDiversity = output.metrics.visualLayoutDiversityRatio

  if (isImageHeavyPptxReference(reference) && outputPictureRatio === 0) {
    errors.push(
      'The reference deck is image-heavy, but the generated deck contains no picture slides. Add topic-relevant image assets instead of delivering a text-only approximation.'
    )
  } else if (
    reference.metrics.pictureSlideRatio >= 0.25 &&
    outputPictureRatio < reference.metrics.pictureSlideRatio * 0.7
  ) {
    errors.push(
      `Picture-slide coverage is too far below the reference (${percent(outputPictureRatio)} vs ${percent(reference.metrics.pictureSlideRatio)}). Add enough distinct, topic-relevant images to preserve the source deck's visual cadence.`
    )
  }

  if (reference.metrics.chartSlideRatio >= 0.08 && outputChartRatio === 0) {
    warnings.push(
      'The reference deck uses chart-led evidence, but the generated deck contains no chart-oriented slide.'
    )
  }
  if (referenceDiversity >= 0.45 && outputDiversity < referenceDiversity * 0.65) {
    errors.push(
      `Visual layout diversity collapsed relative to the reference (${percent(outputDiversity)} vs ${percent(referenceDiversity)}). Rebuild the slide rhythm instead of recoloring one layout skeleton.`
    )
  }
  if (Math.abs(output.metrics.darkSlideRatio - reference.metrics.darkSlideRatio) >= 0.5) {
    errors.push('The generated deck has a substantially different light/dark page rhythm from the reference.')
  }
  if (
    reference.metrics.averageTextUnits >= 80 &&
    output.metrics.averageTextUnits <
      reference.metrics.averageTextUnits * reference.designLanguage.targets.minimumTextDensityRatio
  ) {
    errors.push(
      `Text density is too far below the reference (${Math.round(output.metrics.averageTextUnits)} vs ${Math.round(reference.metrics.averageTextUnits)} CJK-equivalent units per slide). Add evidence, interpretation, or actions while preserving readable spacing.`
    )
  } else if (
    reference.metrics.averageTextUnits >= 80 &&
    output.metrics.averageTextUnits >
      reference.metrics.averageTextUnits * reference.designLanguage.targets.maximumTextDensityRatio
  ) {
    warnings.push(
      'The generated deck is materially denser than the reference; split content before shrinking body text.'
    )
  }

  const components = [
    {
      weight: reference.metrics.pictureSlideRatio >= 0.08 ? 35 : 0,
      value: ratioCoverage(outputPictureRatio, reference.metrics.pictureSlideRatio)
    },
    {
      weight: reference.metrics.chartSlideRatio >= 0.08 ? 15 : 0,
      value: ratioCoverage(outputChartRatio, reference.metrics.chartSlideRatio)
    },
    { weight: 25, value: ratioCoverage(outputDiversity, referenceDiversity) },
    { weight: 10, value: 1 - Math.min(1, Math.abs(output.metrics.darkSlideRatio - reference.metrics.darkSlideRatio)) },
    {
      weight: 8,
      value:
        1 -
        Math.min(
          1,
          Math.abs(output.metrics.averageTextBlocks - reference.metrics.averageTextBlocks) /
            Math.max(2, reference.metrics.averageTextBlocks)
        )
    },
    {
      weight: 7,
      value: ratioCoverage(output.metrics.averageTextUnits, reference.metrics.averageTextUnits)
    }
  ].filter((component) => component.weight > 0)
  const totalWeight = components.reduce((sum, component) => sum + component.weight, 0)
  const calculatedScore = Math.round(
    (components.reduce((sum, component) => sum + component.weight * component.value, 0) / Math.max(1, totalWeight)) *
      100
  )
  const score = calculatedScore
  if (score < 70) {
    errors.push(
      `Reference composition similarity is below the 70/100 delivery threshold (${score}/100). Revise image coverage, page archetypes, and layout rhythm before delivery.`
    )
  }
  const level: PptxReferenceSimilarityResult['level'] = score >= 82 ? 'high' : score >= 70 ? 'medium' : 'low'
  if (level === 'low')
    warnings.push(`Reference composition similarity is low (${score}/100); revise assets or slide layouts.`)

  return {
    score,
    level,
    warnings,
    errors,
    details: {
      style_reference_similarity_score: score,
      style_reference_similarity_level: level,
      style_reference_picture_slide_ratio: reference.metrics.pictureSlideRatio,
      output_picture_slide_ratio: round(outputPictureRatio),
      style_reference_chart_slide_ratio: reference.metrics.chartSlideRatio,
      output_chart_slide_ratio: round(outputChartRatio),
      style_reference_layout_diversity: round(referenceDiversity),
      output_layout_diversity: round(outputDiversity),
      style_reference_dark_slide_ratio: reference.metrics.darkSlideRatio,
      output_dark_slide_ratio: output.metrics.darkSlideRatio,
      style_reference_average_text_units: reference.metrics.averageTextUnits,
      output_average_text_units: output.metrics.averageTextUnits
    }
  }
}

export function comparePptxReferenceDesignLanguage(
  reference: PptxStyleReferenceProfile,
  output: PptxStyleReferenceProfile
): PptxReferenceSimilarityResult {
  const source = reference.designLanguage
  const target = output.designLanguage
  const components = [
    { weight: 22, value: compositionBiasSimilarity(source.compositionBias, target.compositionBias) },
    {
      weight: 16,
      value: orderedCategorySimilarity(source.spatialRhythm, target.spatialRhythm, ['spacious', 'balanced', 'compact'])
    },
    {
      weight: 12,
      value: orderedCategorySimilarity(source.decorationDensity, target.decorationDensity, [
        'minimal',
        'restrained',
        'rich'
      ])
    },
    { weight: 14, value: surfaceTreatmentSimilarity(source.surfaceTreatment, target.surfaceTreatment) },
    {
      weight: 10,
      value:
        source.alignment === target.alignment
          ? 1
          : source.alignment === 'mixed' || target.alignment === 'mixed'
            ? 0.62
            : 0.25
    },
    { weight: 10, value: shapeLanguageSimilarity(source.shapeLanguage, target.shapeLanguage) },
    { weight: 8, value: orderedCategorySimilarity(source.contrast, target.contrast, ['soft', 'balanced', 'high']) },
    {
      weight: 8,
      value: orderedCategorySimilarity(source.paletteStrategy, target.paletteStrategy, [
        'monochrome',
        'single-accent',
        'multi-accent'
      ])
    }
  ]
  const score = Math.round(
    (components.reduce((sum, component) => sum + component.weight * component.value, 0) /
      components.reduce((sum, component) => sum + component.weight, 0)) *
      100
  )
  const level: PptxReferenceSimilarityResult['level'] = score >= 82 ? 'high' : score >= 65 ? 'medium' : 'low'
  const warnings =
    score < 65
      ? [
          `Screenshot design-language similarity is low (${score}/100); revise composition bias, whitespace, shape vocabulary, or surface treatment instead of only matching colors.`
        ]
      : score < 76
        ? [
            `Screenshot design-language similarity is moderate (${score}/100); inspect the rendered deck for composition and whitespace fidelity.`
          ]
        : []
  return {
    score,
    level,
    warnings,
    errors: [],
    details: {
      style_reference_design_similarity_score: score,
      style_reference_design_similarity_level: level,
      style_reference_composition_bias: source.compositionBias,
      output_composition_bias: target.compositionBias,
      style_reference_spatial_rhythm: source.spatialRhythm,
      output_spatial_rhythm: target.spatialRhythm,
      style_reference_decoration_density: source.decorationDensity,
      output_decoration_density: target.decorationDensity,
      style_reference_surface_treatment: source.surfaceTreatment,
      output_surface_treatment: target.surfaceTreatment
    }
  }
}

function orderedCategorySimilarity<T extends string>(left: T, right: T, order: readonly T[]) {
  if (left === right) return 1
  const distance = Math.abs(order.indexOf(left) - order.indexOf(right))
  return distance === 1 ? 0.62 : 0.2
}

function compositionBiasSimilarity(
  left: PptxDesignLanguageProfile['compositionBias'],
  right: PptxDesignLanguageProfile['compositionBias']
) {
  if (left === right) return 1
  if (left === 'balanced' || right === 'balanced') return 0.65
  if (left === 'centered' || right === 'centered') return 0.45
  const horizontal = new Set(['left-led', 'right-led'])
  const vertical = new Set(['top-led', 'bottom-led'])
  if ((horizontal.has(left) && horizontal.has(right)) || (vertical.has(left) && vertical.has(right))) return 0.2
  return 0.35
}

function shapeLanguageSimilarity(
  left: PptxDesignLanguageProfile['shapeLanguage'],
  right: PptxDesignLanguageProfile['shapeLanguage']
) {
  if (left === right) return 1
  if (left === 'mixed' || right === 'mixed') return 0.65
  if (
    new Set([left, right]).size === 2 &&
    ['rounded', 'circular'].includes(left) &&
    ['rounded', 'circular'].includes(right)
  ) {
    return 0.82
  }
  if (['open', 'linear'].includes(left) && ['open', 'linear'].includes(right)) return 0.68
  if (['linear', 'rectilinear'].includes(left) && ['linear', 'rectilinear'].includes(right)) return 0.62
  return 0.25
}

function surfaceTreatmentSimilarity(
  left: PptxDesignLanguageProfile['surfaceTreatment'],
  right: PptxDesignLanguageProfile['surfaceTreatment']
) {
  if (left === right) return 1
  if (left === 'mixed' || right === 'mixed') return 0.72
  if (['photographic', 'textured'].includes(left) && ['photographic', 'textured'].includes(right)) return 0.65
  if (['flat', 'layered'].includes(left) && ['flat', 'layered'].includes(right)) return 0.58
  return 0.22
}

function parseXml(source: string): XmlRecord {
  const parsed = xmlParser.parse(source)
  if (!parsed || typeof parsed !== 'object') throw new Error('Reference PPTX contains malformed XML')
  return parsed as XmlRecord
}

function readThemeProfile(zip: AdmZip, slidePart?: string): ThemeProfile {
  const layoutPart = slidePart ? relatedPart(zip, slidePart, 'slideLayout') : undefined
  const masterPart = layoutPart ? relatedPart(zip, layoutPart, 'slideMaster') : undefined
  const relatedThemePart = masterPart ? relatedPart(zip, masterPart, 'theme') : undefined
  const themePart =
    relatedThemePart ||
    zip
      .getEntries()
      .map((entry) => entry.entryName)
      .find((entryName) => /^ppt\/theme\/theme\d+\.xml$/.test(entryName))
  if (!themePart) return { colors: {} }

  const theme = child(parseXml(zip.readAsText(themePart)), 'theme')
  const elements = child(theme, 'themeElements')
  const scheme = child(elements, 'clrScheme')
  const fontScheme = child(elements, 'fontScheme')
  const colors = Object.fromEntries(
    ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
      .map((name) => [name, readDrawingColor(child(scheme, name), {})])
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
  )
  const major = child(fontScheme, 'majorFont')
  const minor = child(fontScheme, 'minorFont')
  return {
    colors,
    headingFont: fontTypeface(child(major, 'latin')),
    bodyFont: fontTypeface(child(minor, 'latin')),
    eastAsiaFont:
      fontTypeface(child(major, 'ea')) ||
      fontTypeface(child(minor, 'ea')) ||
      findScriptFont(major, 'Hans') ||
      findScriptFont(minor, 'Hans')
  }
}

function analyzeSlideXml(
  source: string,
  slideWidth: number,
  slideHeight: number,
  scheme: Record<string, string>,
  inheritedBackground: string
): SlideVisualMetrics {
  if (!source) throw new Error('Reference PPTX contains an unreadable slide')
  const slide = child(parseXml(source), 'sld')
  const common = child(slide, 'cSld')
  const tree = child(common, 'spTree')
  const colorCounts = new Map<string, number>()
  let backgroundColor = readCommonBackground(common, scheme) || inheritedBackground
  let filledShapes = 0
  let lineShapes = 0
  let ellipseShapes = 0
  let rectShapes = 0
  let roundedShapes = 0
  let largeColorFields = 0
  let pictureCoverage = 0
  let largestPictureCoverage = 0
  let picturePlacement: PptxReferencePicturePlacement = 'none'
  let chartCount = 0
  let numericText = 0
  let textBlocks = 0
  let textUnits = 0
  let largestFontPoints = 0
  let centeredTextBlocks = 0
  let textCenterXTotal = 0
  let textCenterYTotal = 0
  let positionedTextBlocks = 0

  for (const shape of descendants(tree, 'sp')) {
    const properties = child(shape, 'spPr')
    const bounds = readBounds(child(properties, 'xfrm'))
    const name = stringValue(child(child(shape, 'nvSpPr'), 'cNvPr')?.name)
    const fill = readDrawingColor(child(properties, 'solidFill'), scheme)
    const geometry = stringValue(child(properties, 'prstGeom')?.prst)
    const areaRatio = bounds ? (bounds.width * bounds.height) / (slideWidth * slideHeight) : 0
    const isCanvas = Boolean(
      bounds && bounds.x <= slideWidth * 0.01 && bounds.y <= slideHeight * 0.01 && areaRatio >= 0.9
    )

    if (isCanvas || /background|背景/i.test(name)) {
      if (fill) backgroundColor = fill
      continue
    }
    if (fill) {
      filledShapes++
      incrementColor(colorCounts, fill)
      if (areaRatio >= 0.12) largeColorFields++
    }
    if (geometry === 'ellipse') ellipseShapes++
    if (geometry === 'rect') rectShapes++
    if (/roundRect|round1Rect|round2SameRect|round2DiagRect/i.test(geometry)) roundedShapes++
    if (/chart|graph|plot|图表|趋势图|柱状图|折线图/i.test(name)) chartCount++
    if (bounds && Math.min(bounds.width, bounds.height) / Math.max(bounds.width, bounds.height) <= 0.045) {
      lineShapes++
    }

    const textBody = child(shape, 'txBody')
    const visibleText = collectText(textBody)
    if (visibleText) {
      textBlocks++
      textUnits += equivalentDisplayUnits(visibleText)
      largestFontPoints = Math.max(largestFontPoints, largestTextPointSize(textBody))
      if (textBlockIsCentered(textBody)) centeredTextBlocks++
      if (bounds) {
        textCenterXTotal += (bounds.x + bounds.width / 2) / slideWidth
        textCenterYTotal += (bounds.y + bounds.height / 2) / slideHeight
        positionedTextBlocks++
      }
      if (/\d|[%％$￥¥€£]/u.test(visibleText)) numericText++
    }
  }

  lineShapes += descendants(tree, 'cxnSp').length

  for (const picture of descendants(tree, 'pic')) {
    const bounds = readBounds(child(child(picture, 'spPr'), 'xfrm'))
    if (bounds) {
      const coverage = (bounds.width * bounds.height) / (slideWidth * slideHeight)
      pictureCoverage += coverage
      if (coverage > largestPictureCoverage) {
        largestPictureCoverage = coverage
        picturePlacement = classifyPicturePlacement(bounds, slideWidth, slideHeight, coverage)
      }
    }
  }

  chartCount += descendants(tree, 'graphicFrame').filter(hasChartReference).length

  return {
    backgroundColor: normalizeColor(backgroundColor) || 'FFFFFF',
    filledShapes,
    lineShapes,
    ellipseShapes,
    rectShapes,
    roundedShapes,
    largeColorFields,
    pictureCoverage: Math.min(1, pictureCoverage),
    largestPictureCoverage: Math.min(1, largestPictureCoverage),
    picturePlacement,
    chartCount,
    numericText,
    textBlocks,
    textUnits,
    largestFontPoints,
    centeredTextBlocks,
    averageTextCenterX: positionedTextBlocks ? textCenterXTotal / positionedTextBlocks : 0.5,
    averageTextCenterY: positionedTextBlocks ? textCenterYTotal / positionedTextBlocks : 0.5,
    colorCounts
  }
}

function classifyPicturePlacement(
  bounds: { x: number; y: number; width: number; height: number },
  slideWidth: number,
  slideHeight: number,
  coverage: number
): PptxReferencePicturePlacement {
  if (
    coverage >= 0.72 ||
    (bounds.x <= slideWidth * 0.04 &&
      bounds.y <= slideHeight * 0.04 &&
      bounds.width >= slideWidth * 0.9 &&
      bounds.height >= slideHeight * 0.9)
  ) {
    return 'full'
  }
  const centerX = (bounds.x + bounds.width / 2) / slideWidth
  const centerY = (bounds.y + bounds.height / 2) / slideHeight
  if (bounds.width >= slideWidth * 0.7) return centerY < 0.45 ? 'top' : 'bottom'
  if (bounds.height >= slideHeight * 0.58) return centerX < 0.5 ? 'left' : 'right'
  return 'center'
}

function aggregateSlideMetrics(slides: SlideVisualMetrics[], nativeLayoutCount = 0) {
  const count = Math.max(slides.length, 1)
  const colorCounts = new Map<string, number>()
  for (const slide of slides) {
    for (const [color, occurrences] of slide.colorCounts) incrementColor(colorCounts, color, occurrences)
  }
  const sum = (pick: (slide: SlideVisualMetrics) => number) => slides.reduce((total, slide) => total + pick(slide), 0)
  const totalTextBlocks = Math.max(
    1,
    sum((slide) => slide.textBlocks)
  )
  const visualLayoutCount = new Set(slides.map(visualLayoutSignature)).size
  return {
    colorCounts,
    metrics: {
      averageFilledShapes: round(sum((slide) => slide.filledShapes) / count),
      averageLineShapes: round(sum((slide) => slide.lineShapes) / count),
      averageEllipseShapes: round(sum((slide) => slide.ellipseShapes) / count),
      averageRectShapes: round(sum((slide) => slide.rectShapes) / count),
      averageRoundedShapes: round(sum((slide) => slide.roundedShapes) / count),
      averageLargeColorFields: round(sum((slide) => slide.largeColorFields) / count),
      averagePictureCoverage: round(sum((slide) => slide.pictureCoverage) / count),
      pictureSlideRatio: round(slides.filter((slide) => slide.pictureCoverage >= 0.01).length / count),
      chartSlideRatio: round(slides.filter((slide) => slide.chartCount > 0).length / count),
      averageTextBlocks: round(sum((slide) => slide.textBlocks) / count),
      averageTextUnits: round(sum((slide) => slide.textUnits) / count),
      averageLargestFontPoints: round(sum((slide) => slide.largestFontPoints) / count),
      centeredTextRatio: round(sum((slide) => slide.centeredTextBlocks) / totalTextBlocks),
      denseTextSlideRatio: round(slides.filter((slide) => slide.textBlocks >= 7).length / count),
      darkSlideRatio: round(slides.filter((slide) => colorLuminance(slide.backgroundColor) < 0.34).length / count),
      nativeLayoutCount,
      nativeLayoutDiversityRatio: round(nativeLayoutCount / count),
      visualLayoutDiversityRatio: round(visualLayoutCount / count),
      numericTextRatio: round(sum((slide) => slide.numericText) / totalTextBlocks)
    }
  }
}

async function analyzeReferenceImage(filePath: string): Promise<PptxStyleReferenceProfile> {
  const source = sharp(filePath, { failOn: 'error' })
  const metadata = await source.metadata()
  const dimensions = orientedImageDimensions(metadata.width, metadata.height, metadata.orientation)
  const width = dimensions.width
  const height = dimensions.height
  const sampleWidth = 192
  const sampleHeight = Math.max(72, Math.min(192, Math.round(sampleWidth * (height / Math.max(width, 1)))))
  const sample = await source
    .clone()
    .rotate()
    .flatten({ background: '#FFFFFF' })
    .resize(sampleWidth, sampleHeight, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const histogram = new Map<string, number>()
  for (let offset = 0; offset + 2 < sample.data.length; offset += sample.info.channels) {
    incrementColor(histogram, quantizeColor(sample.data[offset], sample.data[offset + 1], sample.data[offset + 2]))
  }
  const backgroundColor = imageBackgroundColor(sample.data, sample.info, histogram)
  const palette = selectPalette(histogram, backgroundColor, [])
  const imageAnalysis = analyzeReferenceImagePixels(sample.data, sample.info, backgroundColor)
  const suggestedMode: ResolvedDocumentStyleMode = colorLuminance(backgroundColor) < 0.34 ? 'dark' : 'light'
  const observedColors = [...histogram.entries()]
    .filter(([color]) => colorDistance(color, backgroundColor) >= 42)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([color]) => color)
  const observedSaturations = (observedColors.length ? observedColors : palette).map(colorSaturation)
  const averageSaturation =
    observedSaturations.reduce((sum, saturation) => sum + saturation, 0) / observedSaturations.length
  const paletteStrategy: PptxDesignLanguageProfile['paletteStrategy'] =
    averageSaturation < 0.12
      ? 'monochrome'
      : observedSaturations.filter((saturation) => saturation >= 0.28).length <= 1
        ? 'single-accent'
        : 'multi-accent'
  const maximumContrast = Math.max(
    ...(observedColors.length ? observedColors : palette).map((color) => colorDistance(backgroundColor, color))
  )
  const contrast: PptxDesignLanguageProfile['contrast'] =
    maximumContrast >= 220 ? 'high' : maximumContrast >= 125 ? 'balanced' : 'soft'
  const spatialRhythm: PptxDesignLanguageProfile['spatialRhythm'] =
    imageAnalysis.activeContentRatio < 0.24
      ? 'spacious'
      : imageAnalysis.activeContentRatio > 0.56
        ? 'compact'
        : 'balanced'
  const decorationDensity: PptxDesignLanguageProfile['decorationDensity'] =
    imageAnalysis.activeContentRatio < 0.22 && imageAnalysis.edgeDensity < 0.08
      ? 'minimal'
      : imageAnalysis.activeContentRatio > 0.54 || imageAnalysis.edgeDensity > 0.22
        ? 'rich'
        : 'restrained'
  const surfaceTreatment: PptxDesignLanguageProfile['surfaceTreatment'] =
    imageAnalysis.photographicCoverage >= 0.5
      ? 'photographic'
      : imageAnalysis.photographicCoverage >= 0.16
        ? 'mixed'
        : imageAnalysis.textureScore >= 0.16
          ? 'textured'
          : decorationDensity === 'rich'
            ? 'layered'
            : 'flat'
  const shapeLanguage: PptxDesignLanguageProfile['shapeLanguage'] =
    spatialRhythm === 'spacious' && decorationDensity === 'minimal'
      ? 'open'
      : surfaceTreatment === 'layered'
        ? 'rectilinear'
        : imageAnalysis.edgeDensity >= 0.16 && imageAnalysis.activeContentRatio < 0.48
          ? 'linear'
          : 'mixed'
  const contentDensityValue: PptxContentDensity =
    spatialRhythm === 'spacious' ? 'sparse' : spatialRhythm === 'compact' ? 'dense' : 'balanced'
  const imageTreatment: PptxDesignLanguageProfile['imageTreatment'] =
    imageAnalysis.photographicCoverage < 0.16
      ? 'none'
      : imageAnalysis.picturePlacement === 'full'
        ? 'full-bleed'
        : imageAnalysis.photographicCoverage >= 0.35
          ? 'mixed'
          : 'framed'
  const pageRhythm: PptxDesignLanguageProfile['pageRhythm'] =
    imageTreatment !== 'none' ||
    (['left-led', 'right-led'].includes(imageAnalysis.compositionBias) &&
      decorationDensity === 'restrained' &&
      spatialRhythm !== 'spacious')
      ? 'editorial'
      : contentDensityValue === 'dense' && shapeLanguage !== 'open'
        ? 'evidence-led'
        : 'quiet'
  const typographyScale: PptxDesignLanguageProfile['typographyScale'] =
    spatialRhythm === 'spacious' ? 'display' : spatialRhythm === 'compact' ? 'compact' : 'balanced'
  const alignment: PptxDesignLanguageProfile['alignment'] =
    imageAnalysis.compositionBias === 'centered'
      ? 'centered'
      : imageAnalysis.compositionBias === 'left-led'
        ? 'left-led'
        : 'mixed'
  const suggestedVisualStyle = suggestImageVisualStyle({
    mode: suggestedMode,
    averageSaturation,
    paletteStrategy,
    contrast,
    spatialRhythm,
    decorationDensity,
    surfaceTreatment,
    compositionBias: imageAnalysis.compositionBias
  })
  const inferredArchetype: PptxReferenceSlideArchetype =
    imageAnalysis.picturePlacement === 'full' && imageAnalysis.photographicCoverage >= 0.45
      ? 'full-bleed-image'
      : imageAnalysis.photographicCoverage >= 0.3
        ? 'photo-chapter'
        : imageAnalysis.photographicCoverage >= 0.16
          ? 'image-text'
          : contentDensityValue === 'dense'
            ? 'dense-report'
            : 'open-report'
  const aspectRatio = width / height
  return {
    kind: 'image',
    sourcePath: filePath,
    slideCount: 1,
    width,
    height,
    aspectRatio: round(aspectRatio),
    aspectRatioCompatible: Math.abs(aspectRatio - WIDE_ASPECT_RATIO) <= 0.08,
    suggestedVisualStyle,
    suggestedMode,
    layoutConfidence:
      imageAnalysis.activeContentRatio >= 0.04 && imageAnalysis.activeContentRatio <= 0.9 ? 'medium' : 'low',
    primaryColor: palette[0],
    secondaryColor: palette[1],
    accentColor: palette[2],
    backgroundColor,
    metrics: {
      averageFilledShapes: 0,
      averageLineShapes: 0,
      averageEllipseShapes: 0,
      averageRectShapes: 0,
      averageRoundedShapes: 0,
      averageLargeColorFields: 0,
      averagePictureCoverage: imageAnalysis.photographicCoverage,
      pictureSlideRatio: imageAnalysis.photographicCoverage >= 0.16 ? 1 : 0,
      chartSlideRatio: 0,
      averageTextBlocks: 0,
      averageTextUnits: 0,
      averageLargestFontPoints: 0,
      centeredTextRatio: 0,
      denseTextSlideRatio: 0,
      darkSlideRatio: suggestedMode === 'dark' ? 1 : 0,
      nativeLayoutCount: 0,
      nativeLayoutDiversityRatio: 0,
      visualLayoutDiversityRatio: 1,
      numericTextRatio: 0
    },
    composition: {
      slides: [
        {
          slideNumber: 1,
          archetype: inferredArchetype,
          dark: suggestedMode === 'dark',
          pictureCoverage: imageAnalysis.photographicCoverage,
          picturePlacement: imageAnalysis.picturePlacement,
          chartCount: 0,
          textBlocks: 0,
          textUnits: 0,
          density: contentDensityValue
        }
      ]
    },
    imageAnalysis: {
      activeContentRatio: imageAnalysis.activeContentRatio,
      activeBoundsWidthRatio: imageAnalysis.activeBoundsWidthRatio,
      activeBoundsHeightRatio: imageAnalysis.activeBoundsHeightRatio,
      centroidX: imageAnalysis.centroidX,
      centroidY: imageAnalysis.centroidY,
      leftVisualWeight: imageAnalysis.leftVisualWeight,
      rightVisualWeight: imageAnalysis.rightVisualWeight,
      topVisualWeight: imageAnalysis.topVisualWeight,
      bottomVisualWeight: imageAnalysis.bottomVisualWeight,
      edgeDensity: imageAnalysis.edgeDensity,
      textureScore: imageAnalysis.textureScore,
      photographicCoverage: imageAnalysis.photographicCoverage
    },
    designLanguage: {
      paletteStrategy,
      contrast,
      typographyScale,
      alignment,
      shapeLanguage,
      contentDensity: contentDensityValue,
      imageTreatment,
      pageRhythm,
      compositionBias: imageAnalysis.compositionBias,
      spatialRhythm,
      decorationDensity,
      surfaceTreatment,
      targets: {
        minimumTextDensityRatio:
          contentDensityValue === 'dense' ? 0.7 : contentDensityValue === 'balanced' ? 0.6 : 0.45,
        maximumTextDensityRatio:
          contentDensityValue === 'dense' ? 1.08 : contentDensityValue === 'balanced' ? 1.15 : 1.25,
        minimumLayoutDiversityRatio: 0.4,
        pictureSlideRatio: imageAnalysis.photographicCoverage >= 0.16 ? 0.35 : 0,
        chartSlideRatio: 0,
        darkSlideRatio: suggestedMode === 'dark' ? 1 : 0
      }
    },
    warnings: [
      'Screenshot references inherit palette, composition bias, spatial rhythm, image treatment, and broad visual direction; exact geometry, fonts, icons, and master layouts are not cloned.',
      ...(Math.abs(aspectRatio - WIDE_ASPECT_RATIO) > 0.08
        ? ['Reference image aspect ratio differs from 16:9; output remains 16:9.']
        : [])
    ]
  }
}

interface ImagePixelAnalysis extends PptxReferenceImageAnalysis {
  compositionBias: PptxDesignLanguageProfile['compositionBias']
  picturePlacement: PptxReferencePicturePlacement
}

function analyzeReferenceImagePixels(
  pixels: Buffer,
  info: { width: number; height: number; channels: number },
  backgroundColor: string
): ImagePixelAnalysis {
  const [backgroundRed, backgroundGreen, backgroundBlue] = colorChannels(backgroundColor)
  const totalPixels = Math.max(1, info.width * info.height)
  const edgeBandX = Math.max(1, Math.floor(info.width * 0.045))
  const edgeBandY = Math.max(1, Math.floor(info.height * 0.045))
  const tileColumns = 12
  const tileRows = 8
  const tiles = Array.from({ length: tileColumns * tileRows }, () => ({
    count: 0,
    luminanceSum: 0,
    luminanceSquaredSum: 0,
    neighborDifferenceSum: 0,
    neighborCount: 0,
    colors: new Set<string>()
  }))
  let activePixels = 0
  let edgeActivePixels = 0
  let edgePixels = 0
  let weightedX = 0
  let weightedY = 0
  let totalWeight = 0
  let leftWeight = 0
  let rightWeight = 0
  let topWeight = 0
  let bottomWeight = 0
  let minimumX = info.width
  let maximumX = -1
  let minimumY = info.height
  let maximumY = -1
  let neighborDifferenceSum = 0
  let neighborCount = 0

  const rgbAt = (x: number, y: number) => {
    const offset = (y * info.width + x) * info.channels
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2]] as const
  }
  const rgbDistance = (left: readonly number[], right: readonly number[]) =>
    Math.sqrt((left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2)

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const rgb = rgbAt(x, y)
      const backgroundDistance = Math.sqrt(
        (rgb[0] - backgroundRed) ** 2 + (rgb[1] - backgroundGreen) ** 2 + (rgb[2] - backgroundBlue) ** 2
      )
      const active = backgroundDistance >= 34
      const weight = Math.min(1, Math.max(0, (backgroundDistance - 18) / 130))
      const onEdge = x < edgeBandX || x >= info.width - edgeBandX || y < edgeBandY || y >= info.height - edgeBandY
      if (onEdge) {
        edgePixels++
        if (active) edgeActivePixels++
      }
      if (active) {
        activePixels++
        minimumX = Math.min(minimumX, x)
        maximumX = Math.max(maximumX, x)
        minimumY = Math.min(minimumY, y)
        maximumY = Math.max(maximumY, y)
      }
      if (weight > 0) {
        weightedX += (x / Math.max(1, info.width - 1)) * weight
        weightedY += (y / Math.max(1, info.height - 1)) * weight
        totalWeight += weight
        if (x < info.width / 2) leftWeight += weight
        else rightWeight += weight
        if (y < info.height / 2) topWeight += weight
        else bottomWeight += weight
      }

      const tileX = Math.min(tileColumns - 1, Math.floor((x / info.width) * tileColumns))
      const tileY = Math.min(tileRows - 1, Math.floor((y / info.height) * tileRows))
      const tile = tiles[tileY * tileColumns + tileX]
      const luminance = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114
      tile.count++
      tile.luminanceSum += luminance
      tile.luminanceSquaredSum += luminance * luminance
      tile.colors.add(quantizeColor(rgb[0], rgb[1], rgb[2]))

      if (x > 0) {
        const difference = rgbDistance(rgb, rgbAt(x - 1, y))
        neighborDifferenceSum += difference
        neighborCount++
        tile.neighborDifferenceSum += difference
        tile.neighborCount++
      }
      if (y > 0) {
        const difference = rgbDistance(rgb, rgbAt(x, y - 1))
        neighborDifferenceSum += difference
        neighborCount++
        tile.neighborDifferenceSum += difference
        tile.neighborCount++
      }
    }
  }

  const horizontalWeight = Math.max(1, leftWeight + rightWeight)
  const verticalWeight = Math.max(1, topWeight + bottomWeight)
  const leftVisualWeight = leftWeight / horizontalWeight
  const rightVisualWeight = rightWeight / horizontalWeight
  const topVisualWeight = topWeight / verticalWeight
  const bottomVisualWeight = bottomWeight / verticalWeight
  const centroidX = totalWeight > 0 ? weightedX / totalWeight : 0.5
  const centroidY = totalWeight > 0 ? weightedY / totalWeight : 0.5
  const compositionBias: PptxDesignLanguageProfile['compositionBias'] =
    leftVisualWeight - rightVisualWeight >= 0.16
      ? 'left-led'
      : rightVisualWeight - leftVisualWeight >= 0.16
        ? 'right-led'
        : topVisualWeight - bottomVisualWeight >= 0.22
          ? 'top-led'
          : bottomVisualWeight - topVisualWeight >= 0.22
            ? 'bottom-led'
            : Math.abs(centroidX - 0.5) <= 0.07 && Math.abs(centroidY - 0.5) <= 0.1
              ? 'centered'
              : 'balanced'

  const photographicTiles: number[] = []
  tiles.forEach((tile, index) => {
    const count = Math.max(1, tile.count)
    const mean = tile.luminanceSum / count
    const variance = Math.max(0, tile.luminanceSquaredSum / count - mean * mean)
    const neighborDifference = tile.neighborDifferenceSum / Math.max(1, tile.neighborCount)
    if (variance >= 620 && tile.colors.size >= 16 && neighborDifference >= 16) photographicTiles.push(index)
  })
  const photographicCoverage = photographicTiles.length / tiles.length
  let picturePlacement: PptxReferencePicturePlacement = 'none'
  if (photographicTiles.length > 0) {
    const photoColumns = photographicTiles.map((index) => index % tileColumns)
    const photoRows = photographicTiles.map((index) => Math.floor(index / tileColumns))
    const minColumn = Math.min(...photoColumns)
    const maxColumn = Math.max(...photoColumns)
    const minRow = Math.min(...photoRows)
    const maxRow = Math.max(...photoRows)
    const widthRatio = (maxColumn - minColumn + 1) / tileColumns
    const heightRatio = (maxRow - minRow + 1) / tileRows
    const centerX = (minColumn + maxColumn + 1) / (2 * tileColumns)
    const centerY = (minRow + maxRow + 1) / (2 * tileRows)
    const touchedEdges =
      Number(minColumn === 0) +
      Number(maxColumn === tileColumns - 1) +
      Number(minRow === 0) +
      Number(maxRow === tileRows - 1)
    picturePlacement =
      touchedEdges >= 3 && widthRatio >= 0.75 && heightRatio >= 0.7
        ? 'full'
        : widthRatio >= 0.68
          ? centerY < 0.5
            ? 'top'
            : 'bottom'
          : heightRatio >= 0.58
            ? centerX < 0.5
              ? 'left'
              : 'right'
            : centerX < 0.4
              ? 'left'
              : centerX > 0.6
                ? 'right'
                : 'center'
  }

  return {
    activeContentRatio: round(activePixels / totalPixels),
    activeBoundsWidthRatio: round(maximumX >= minimumX ? (maximumX - minimumX + 1) / info.width : 0),
    activeBoundsHeightRatio: round(maximumY >= minimumY ? (maximumY - minimumY + 1) / info.height : 0),
    centroidX: round(centroidX),
    centroidY: round(centroidY),
    leftVisualWeight: round(leftVisualWeight),
    rightVisualWeight: round(rightVisualWeight),
    topVisualWeight: round(topVisualWeight),
    bottomVisualWeight: round(bottomVisualWeight),
    edgeDensity: round(edgeActivePixels / Math.max(1, edgePixels)),
    textureScore: round(Math.min(1, neighborDifferenceSum / Math.max(1, neighborCount) / 55)),
    photographicCoverage: round(photographicCoverage),
    compositionBias,
    picturePlacement
  }
}

function suggestImageVisualStyle(input: {
  mode: ResolvedDocumentStyleMode
  averageSaturation: number
  paletteStrategy: PptxDesignLanguageProfile['paletteStrategy']
  contrast: PptxDesignLanguageProfile['contrast']
  spatialRhythm: PptxDesignLanguageProfile['spatialRhythm']
  decorationDensity: PptxDesignLanguageProfile['decorationDensity']
  surfaceTreatment: PptxDesignLanguageProfile['surfaceTreatment']
  compositionBias: PptxDesignLanguageProfile['compositionBias']
}): VisualStyleId {
  if (['photographic', 'mixed'].includes(input.surfaceTreatment)) return 'editorial'
  if (input.surfaceTreatment === 'textured') return 'creative'
  if (input.mode === 'dark') {
    if (input.spatialRhythm === 'spacious' && input.paletteStrategy !== 'multi-accent') return 'premium'
    return input.decorationDensity === 'rich' && input.contrast === 'high' ? 'bold' : 'technology'
  }
  if (
    ['left-led', 'right-led'].includes(input.compositionBias) &&
    input.decorationDensity === 'restrained' &&
    input.spatialRhythm !== 'compact'
  ) {
    return 'editorial'
  }
  if (input.spatialRhythm === 'spacious' && input.paletteStrategy === 'monochrome') return 'minimal-light'
  if (input.decorationDensity === 'rich' && input.paletteStrategy === 'multi-accent') return 'brand'
  if (input.averageSaturation > 0.42) return 'brand'
  return input.contrast === 'high' && input.spatialRhythm !== 'compact' ? 'consulting' : 'corporate'
}

function hasChartReference(node: XmlRecord) {
  let found = false
  walk(node, (record) => {
    if (found) return
    if (Object.entries(record).some(([key, value]) => key === 'chart' || stringValue(value).includes('/chart'))) {
      found = true
    }
  })
  return found
}

function visualLayoutSignature(slide: SlideVisualMetrics) {
  const bucket = (value: number, low: number, high: number) => (value <= low ? 0 : value <= high ? 1 : 2)
  return [
    bucket(slide.pictureCoverage, 0.01, 0.3),
    slide.chartCount > 0 ? 1 : 0,
    bucket(slide.textBlocks, 3, 7),
    bucket(slide.filledShapes, 2, 6),
    bucket(slide.largeColorFields, 0, 1),
    bucket(slide.ellipseShapes, 0, 2),
    colorLuminance(slide.backgroundColor) < 0.34 ? 1 : 0,
    slide.picturePlacement,
    bucket(slide.averageTextCenterX, 0.38, 0.62),
    bucket(slide.averageTextCenterY, 0.38, 0.65)
  ].join(':')
}

function referenceSlidePattern(metrics: SlideVisualMetrics, slideNumber: number): PptxReferenceSlidePattern {
  const archetype: PptxReferenceSlideArchetype =
    metrics.pictureCoverage >= 0.72
      ? 'full-bleed-image'
      : metrics.pictureCoverage >= 0.42 && metrics.textBlocks <= 5
        ? 'photo-chapter'
        : metrics.pictureCoverage >= 0.12
          ? 'image-text'
          : metrics.chartCount > 0
            ? 'chart-report'
            : metrics.textBlocks >= 7
              ? 'dense-report'
              : 'open-report'
  return {
    slideNumber,
    archetype,
    dark: colorLuminance(metrics.backgroundColor) < 0.34,
    pictureCoverage: round(metrics.pictureCoverage),
    picturePlacement: metrics.picturePlacement,
    chartCount: metrics.chartCount,
    textBlocks: metrics.textBlocks,
    textUnits: round(metrics.textUnits),
    density: contentDensity(metrics.textUnits, metrics.textBlocks)
  }
}

function deriveDesignLanguage(
  metrics: PptxStyleReferenceProfile['metrics'],
  slides: SlideVisualMetrics[],
  palette: string[],
  backgroundColor: string
): PptxDesignLanguageProfile {
  const saturations = palette.map(colorSaturation)
  const vividColors = saturations.filter((value) => value >= 0.28).length
  const paletteStrategy: PptxDesignLanguageProfile['paletteStrategy'] =
    Math.max(...saturations) < 0.14 ? 'monochrome' : vividColors <= 1 ? 'single-accent' : 'multi-accent'
  const maximumContrast = Math.max(...palette.map((color) => colorDistance(backgroundColor, color)))
  const contrast: PptxDesignLanguageProfile['contrast'] =
    maximumContrast >= 220 ? 'high' : maximumContrast >= 125 ? 'balanced' : 'soft'
  const typographyScale: PptxDesignLanguageProfile['typographyScale'] =
    metrics.averageLargestFontPoints >= 42
      ? 'display'
      : metrics.averageLargestFontPoints > 0 && metrics.averageLargestFontPoints < 26
        ? 'compact'
        : 'balanced'
  const alignment: PptxDesignLanguageProfile['alignment'] =
    metrics.centeredTextRatio >= 0.58 ? 'centered' : metrics.centeredTextRatio <= 0.24 ? 'left-led' : 'mixed'

  const visibleContainers = metrics.averageRectShapes + metrics.averageRoundedShapes + metrics.averageEllipseShapes
  const shapeLanguage: PptxDesignLanguageProfile['shapeLanguage'] =
    visibleContainers <= 1.2 && metrics.averageLineShapes <= 1.2
      ? 'open'
      : metrics.averageLineShapes >= Math.max(2, metrics.averageFilledShapes * 0.9)
        ? 'linear'
        : metrics.averageRoundedShapes >= Math.max(1.5, metrics.averageRectShapes * 0.7)
          ? 'rounded'
          : metrics.averageEllipseShapes >= Math.max(2, metrics.averageRectShapes + metrics.averageRoundedShapes)
            ? 'circular'
            : metrics.averageRectShapes >= Math.max(2, metrics.averageRoundedShapes * 1.6)
              ? 'rectilinear'
              : 'mixed'

  const contentDensityValue = contentDensity(metrics.averageTextUnits, metrics.averageTextBlocks)
  const pictureSlides = slides.filter((slide) => slide.pictureCoverage >= 0.01)
  const fullBleedSlides = pictureSlides.filter((slide) => slide.picturePlacement === 'full')
  const imageTreatment: PptxDesignLanguageProfile['imageTreatment'] =
    pictureSlides.length === 0
      ? 'none'
      : fullBleedSlides.length === pictureSlides.length
        ? 'full-bleed'
        : fullBleedSlides.length === 0
          ? 'framed'
          : 'mixed'
  const pageRhythm: PptxDesignLanguageProfile['pageRhythm'] =
    metrics.pictureSlideRatio >= 0.35
      ? 'editorial'
      : metrics.chartSlideRatio >= 0.14 || metrics.numericTextRatio >= 0.42
        ? 'evidence-led'
        : metrics.darkSlideRatio >= 0.18 && metrics.darkSlideRatio <= 0.82
          ? 'alternating'
          : 'quiet'
  const textCenteredSlides = slides.filter((slide) => slide.textBlocks > 0)
  const averageTextCenterX =
    textCenteredSlides.reduce((sum, slide) => sum + slide.averageTextCenterX, 0) /
    Math.max(1, textCenteredSlides.length)
  const averageTextCenterY =
    textCenteredSlides.reduce((sum, slide) => sum + slide.averageTextCenterY, 0) /
    Math.max(1, textCenteredSlides.length)
  const compositionBias: PptxDesignLanguageProfile['compositionBias'] =
    alignment === 'centered' && Math.abs(averageTextCenterX - 0.5) <= 0.08
      ? 'centered'
      : averageTextCenterX > 0 && averageTextCenterX < 0.42
        ? 'left-led'
        : averageTextCenterX > 0.58
          ? 'right-led'
          : averageTextCenterY > 0 && averageTextCenterY < 0.35
            ? 'top-led'
            : averageTextCenterY > 0.7
              ? 'bottom-led'
              : 'balanced'
  const spatialRhythm: PptxDesignLanguageProfile['spatialRhythm'] =
    contentDensityValue === 'sparse' && visibleContainers <= 3
      ? 'spacious'
      : contentDensityValue === 'dense' || visibleContainers >= 9
        ? 'compact'
        : 'balanced'
  const decorationScore =
    metrics.averageFilledShapes +
    metrics.averageLineShapes +
    metrics.averageEllipseShapes +
    metrics.averageLargeColorFields * 2
  const decorationDensity: PptxDesignLanguageProfile['decorationDensity'] =
    decorationScore <= 3 ? 'minimal' : decorationScore >= 10 ? 'rich' : 'restrained'
  const surfaceTreatment: PptxDesignLanguageProfile['surfaceTreatment'] =
    metrics.averagePictureCoverage >= 0.3
      ? 'photographic'
      : metrics.averagePictureCoverage >= 0.04
        ? 'mixed'
        : metrics.averageLargeColorFields >= 0.8 || decorationDensity === 'rich'
          ? 'layered'
          : 'flat'
  const minimumTextDensityRatio =
    contentDensityValue === 'dense' ? 0.7 : contentDensityValue === 'balanced' ? 0.6 : 0.45
  const maximumTextDensityRatio =
    contentDensityValue === 'dense' ? 1.08 : contentDensityValue === 'balanced' ? 1.15 : 1.25

  return {
    paletteStrategy,
    contrast,
    typographyScale,
    alignment,
    shapeLanguage,
    contentDensity: contentDensityValue,
    imageTreatment,
    pageRhythm,
    compositionBias,
    spatialRhythm,
    decorationDensity,
    surfaceTreatment,
    targets: {
      minimumTextDensityRatio,
      maximumTextDensityRatio,
      minimumLayoutDiversityRatio: round(
        Math.max(0.35, Math.min(0.75, metrics.visualLayoutDiversityRatio * 0.8 || 0.4))
      ),
      pictureSlideRatio: metrics.pictureSlideRatio,
      chartSlideRatio: metrics.chartSlideRatio,
      darkSlideRatio: metrics.darkSlideRatio
    }
  }
}

function contentDensity(textUnits: number, textBlocks: number): PptxContentDensity {
  if (textUnits >= 220 || (textUnits >= 150 && textBlocks >= 7)) return 'dense'
  if (textUnits < 75 && textBlocks <= 4) return 'sparse'
  return 'balanced'
}

function ratioCoverage(actual: number, target: number) {
  return target <= 0.03 ? 1 : Math.min(1, actual / target)
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`
}

function suggestVisualStyle(
  aggregate: ReturnType<typeof aggregateSlideMetrics>,
  palette: string[],
  mode: ResolvedDocumentStyleMode
): VisualStyleId {
  const metrics = aggregate.metrics
  const averageSaturation = palette.reduce((sum, color) => sum + colorSaturation(color), 0) / palette.length
  if (metrics.averagePictureCoverage >= 0.28) return 'editorial'
  if (mode === 'dark') {
    if (metrics.averageFilledShapes <= 3 && metrics.averageLargeColorFields <= 0.5 && averageSaturation < 0.2) {
      return 'premium'
    }
    return metrics.numericTextRatio >= 0.24 ? 'data' : 'technology'
  }
  if (metrics.averageEllipseShapes >= 1.4) return averageSaturation >= 0.34 ? 'children' : 'healthcare'
  if (metrics.averageLargeColorFields >= 1) return averageSaturation >= 0.36 ? 'brand' : 'bold'
  if (metrics.numericTextRatio >= 0.24 && metrics.averageFilledShapes >= 3) return 'data'
  if (metrics.averageLineShapes >= 2 && metrics.averageFilledShapes <= 4) return 'consulting'
  if (metrics.averageFilledShapes <= 2.2) return 'minimal-light'
  if (metrics.averageFilledShapes >= 5) return 'product'
  return 'corporate'
}

function selectPalette(
  counts: Map<string, number>,
  background: string,
  fallbackColors: Array<string | undefined>
): [string, string, string] {
  const maximumCount = Math.max(1, ...counts.values())
  const backgroundLuminance = colorLuminance(background)
  const candidates = [...counts.entries()]
    .filter(([color]) => colorDistance(color, background) >= 42)
    .map(([color, count]) => {
      const luminance = colorLuminance(color)
      const contrast = colorDistance(color, background) / 441
      const isSoftFill =
        (backgroundLuminance >= 0.68 && luminance >= 0.76 && Math.abs(luminance - backgroundLuminance) < 0.2) ||
        (backgroundLuminance <= 0.32 && luminance <= 0.25 && Math.abs(luminance - backgroundLuminance) < 0.16)
      return {
        color,
        score: count * (0.35 + colorSaturation(color) * 0.8 + contrast * 0.9) * (isSoftFill ? 0.35 : 1)
      }
    })
  fallbackColors.forEach((fallback, index) => {
    const normalized = normalizeColor(fallback)
    if (normalized && colorDistance(normalized, background) >= 42) {
      candidates.push({ color: normalized, score: maximumCount * (0.72 - index * 0.06) })
    }
  })
  candidates.sort((left, right) => right.score - left.score)
  candidates.push({ color: '225EA8', score: 0 }, { color: '20A39E', score: 0 }, { color: 'F59E0B', score: 0 })

  const selected: string[] = []
  for (const candidate of candidates) {
    const normalized = normalizeColor(candidate.color)
    if (!normalized || selected.some((color) => colorDistance(color, normalized) < 34)) continue
    selected.push(normalized)
    if (selected.length === 3) break
  }
  while (selected.length < 3) selected.push(['225EA8', '20A39E', 'F59E0B'][selected.length])
  return selected as [string, string, string]
}

function readDrawingColor(node: XmlRecord | undefined, scheme: Record<string, string>): string | undefined {
  if (!node) return undefined
  const srgb = child(node, 'srgbClr')
  const system = child(node, 'sysClr')
  const schemeColor = child(node, 'schemeClr')
  return (
    normalizeColor(stringValue(srgb?.val)) ||
    normalizeColor(stringValue(system?.lastClr)) ||
    normalizeColor(scheme[stringValue(schemeColor?.val)])
  )
}

function readCommonBackground(common: XmlRecord | undefined, scheme: Record<string, string>) {
  const background = child(common, 'bg')
  return (
    readDrawingColor(child(child(background, 'bgPr'), 'solidFill'), scheme) ||
    readDrawingColor(child(background, 'bgRef'), scheme)
  )
}

function readInheritedSlideBackground(zip: AdmZip, slidePart: string, scheme: Record<string, string>) {
  const layoutPart = relatedPart(zip, slidePart, 'slideLayout')
  const masterPart = layoutPart ? relatedPart(zip, layoutPart, 'slideMaster') : undefined
  for (const partName of [layoutPart, masterPart]) {
    if (!partName) continue
    const source = zip.readAsText(partName)
    if (!source) continue
    const document = parseXml(source)
    const root = child(document, 'sldLayout') || child(document, 'sldMaster')
    const color = readCommonBackground(child(root, 'cSld'), scheme)
    if (color) return color
  }
  return undefined
}

function relatedPart(zip: AdmZip, sourcePart: string, relationshipKind: string) {
  const relationshipPart = path.posix.join(
    path.posix.dirname(sourcePart),
    '_rels',
    `${path.posix.basename(sourcePart)}.rels`
  )
  const source = zip.readAsText(relationshipPart)
  if (!source) return undefined
  const relationships = child(parseXml(source), 'Relationships')
  const relationship = children(relationships, 'Relationship').find((item) => {
    const type = stringValue(item.Type)
    return type.endsWith(`/${relationshipKind}`) && stringValue(item.TargetMode).toLowerCase() !== 'external'
  })
  const target = stringValue(relationship?.Target).replace(/\\/g, '/')
  if (!target) return undefined
  const resolved = target.startsWith('/')
    ? target.replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), target))
  return zip.getEntry(resolved) ? resolved : undefined
}

function readBounds(node: XmlRecord | undefined) {
  const offset = child(node, 'off')
  const extent = child(node, 'ext')
  const x = numberValue(offset?.x)
  const y = numberValue(offset?.y)
  const width = positiveNumber(extent?.cx)
  const height = positiveNumber(extent?.cy)
  return width && height ? { x, y, width, height } : undefined
}

function collectText(node: unknown): string {
  const values: string[] = []
  walk(node, (record) => {
    const value = record.t
    if (typeof value === 'string' && value.trim()) values.push(value.trim())
  })
  return values.join(' ')
}

function equivalentDisplayUnits(value: string) {
  return [...value].reduce((total, character) => {
    if (/\s/u.test(character)) return total + 0.3
    if (/\p{P}/u.test(character)) return total + 0.45
    if ((character.codePointAt(0) ?? 0) > 0xff) return total + 1
    return total + 0.55
  }, 0)
}

function largestTextPointSize(node: XmlRecord | undefined) {
  const candidates = ['rPr', 'defRPr', 'endParaRPr'].flatMap((key) => descendants(node, key))
  return candidates.reduce((largest, properties) => Math.max(largest, positiveNumber(properties.sz) / 100), 0)
}

function textBlockIsCentered(node: XmlRecord | undefined) {
  const paragraphs = [...descendants(node, 'pPr'), ...descendants(node, 'defPPr')]
  return paragraphs.some((properties) => ['ctr', 'center'].includes(stringValue(properties.algn).toLowerCase()))
}

function findScriptFont(node: XmlRecord | undefined, script: string) {
  return stringValue(children(node, 'font').find((font) => stringValue(font.script) === script)?.typeface) || undefined
}

function fontTypeface(node: XmlRecord | undefined) {
  const value = stringValue(node?.typeface)
  return value || undefined
}

function child(node: XmlRecord | undefined, key: string): XmlRecord | undefined {
  if (!node) return undefined
  const value = node[key]
  if (Array.isArray(value)) return asRecord(value[0])
  return asRecord(value)
}

function children(node: XmlRecord | undefined, key: string): XmlRecord[] {
  if (!node) return []
  const value = node[key]
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map(asRecord)
    .filter((item): item is XmlRecord => Boolean(item))
}

function descendants(node: unknown, key: string): XmlRecord[] {
  const matches: XmlRecord[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const record = asRecord(value)
    if (!record) return
    for (const [childKey, childValue] of Object.entries(record)) {
      if (childKey === key) {
        const values = Array.isArray(childValue) ? childValue : [childValue]
        values.forEach((item) => {
          const match = asRecord(item)
          if (match) matches.push(match)
        })
      }
      visit(childValue)
    }
  }
  visit(node)
  return matches
}

function asRecord(value: unknown): XmlRecord | undefined {
  return value && typeof value === 'object' ? (value as XmlRecord) : undefined
}

function walk(node: unknown, visit: (record: XmlRecord) => void): void {
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit))
    return
  }
  const record = asRecord(node)
  if (!record) return
  visit(record)
  Object.values(record).forEach((value) => walk(value, visit))
}

function normalizeRequestedSlide(value: number | undefined, slideCount: number) {
  if (value === undefined) return undefined
  const normalized = Math.round(value)
  if (normalized < 1 || normalized > slideCount) {
    throw new Error(`Reference slide_number must be between 1 and ${slideCount}`)
  }
  return normalized
}

function slidePartNumber(value: string) {
  return Number(value.match(/slide(\d+)\.xml$/)?.[1] || 0)
}

function incrementColor(map: Map<string, number>, color: string, amount = 1) {
  const normalized = normalizeColor(color)
  if (normalized) map.set(normalized, (map.get(normalized) || 0) + amount)
}

function mostCommonColor(counts: Map<string, number>, fallback: string) {
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || fallback
}

function imageBackgroundColor(
  pixels: Buffer,
  info: { width: number; height: number; channels: number },
  globalHistogram: Map<string, number>
) {
  const cornerHistogram = new Map<string, number>()
  const patchSize = Math.max(2, Math.floor(Math.min(info.width, info.height) / 12))
  const origins = [
    [0, 0],
    [info.width - patchSize, 0],
    [0, info.height - patchSize],
    [info.width - patchSize, info.height - patchSize]
  ]
  for (const [startX, startY] of origins) {
    for (let y = startY; y < startY + patchSize; y++) {
      for (let x = startX; x < startX + patchSize; x++) {
        const offset = (y * info.width + x) * info.channels
        incrementColor(cornerHistogram, quantizeColor(pixels[offset], pixels[offset + 1], pixels[offset + 2]))
      }
    }
  }
  const cornerColor = mostCommonColor(cornerHistogram, '')
  const cornerShare = cornerColor
    ? (cornerHistogram.get(cornerColor) || 0) /
      Math.max(
        1,
        [...cornerHistogram.values()].reduce((a, b) => a + b, 0)
      )
    : 0
  return cornerShare >= 0.35 ? cornerColor : mostCommonColor(globalHistogram, 'FFFFFF')
}

function orientedImageDimensions(width: number | undefined, height: number | undefined, orientation?: number) {
  const sourceWidth = width || 96
  const sourceHeight = height || 96
  return orientation && orientation >= 5 && orientation <= 8
    ? { width: sourceHeight, height: sourceWidth }
    : { width: sourceWidth, height: sourceHeight }
}

function quantizeColor(red: number, green: number, blue: number) {
  const quantize = (value: number) => Math.min(255, Math.round(value / 32) * 32)
  return [red, green, blue]
    .map(quantize)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

function normalizeColor(value: string | undefined) {
  const normalized = value?.trim().replace(/^#/, '').toUpperCase()
  if (!normalized) return undefined
  const sixDigit = normalized.length === 8 ? normalized.slice(-6) : normalized
  return /^[0-9A-F]{6}$/.test(sixDigit) ? sixDigit : undefined
}

function colorChannels(color: string) {
  return [0, 2, 4].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16))
}

function colorLuminance(color: string) {
  const [red, green, blue] = colorChannels(color).map((channel) => channel / 255)
  return red * 0.299 + green * 0.587 + blue * 0.114
}

function colorSaturation(color: string) {
  const channels = colorChannels(color).map((channel) => channel / 255)
  const maximum = Math.max(...channels)
  const minimum = Math.min(...channels)
  return maximum === 0 ? 0 : (maximum - minimum) / maximum
}

function colorDistance(left: string, right: string) {
  const leftChannels = colorChannels(left)
  const rightChannels = colorChannels(right)
  return Math.sqrt(leftChannels.reduce((sum, channel, index) => sum + (channel - rightChannels[index]) ** 2, 0))
}

function stringValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function numberValue(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function positiveNumber(value: unknown) {
  const parsed = numberValue(value)
  return parsed > 0 ? parsed : 0
}

function round(value: number) {
  return Math.round(value * 1000) / 1000
}
