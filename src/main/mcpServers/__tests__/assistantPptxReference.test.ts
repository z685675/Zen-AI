import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.unmock('node:path')
vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() })
  }
}))
vi.mock('@main/utils', () => ({ toAsarUnpackedPath: (value: string) => value }))
vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => 'test',
    getName: () => 'Zen AI',
    getLocale: () => 'zh-CN',
    isPackaged: false
  }
}))

import { createPptxBuffer } from '../assistant'
import { resolveDocumentStyle } from '../assistantDocumentStyles'
import {
  analyzePptxBuffer,
  analyzePptxStyleReference,
  comparePptxReferenceComposition,
  comparePptxReferenceDesignLanguage,
  isImageHeavyPptxReference,
  type PptxReferenceSlideArchetype
} from '../assistantPptxReference'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('PPTX style references', () => {
  it('keeps whole-deck light/dark rhythm when a dark cover is selected as the representative slide', async () => {
    const style = resolveDocumentStyle({
      visualStyle: 'corporate',
      title: 'Annual report',
      content: 'Cover followed by report pages',
      format: 'pptx'
    })
    const buffer = await createPptxBuffer(
      [
        { title: 'Dark cover', layout: 'cover', accent: 'green', bullets: ['2026'] },
        { title: 'Light report page', layout: 'insight', accent: 'green', bullets: ['Evidence one', 'Evidence two'] },
        { title: 'Light data page', layout: 'chart', accent: 'green', bullets: ['Baseline | 42', 'Current | 68'] }
      ],
      new Map(),
      style
    )

    const profile = analyzePptxBuffer(buffer, 'mixed-rhythm-reference.pptx', 1)

    expect(profile.analyzedSlide).toBe(1)
    expect(profile.suggestedMode).toBe('light')
    expect(profile.metrics.darkSlideRatio).toBeLessThan(0.5)
    expect(profile.composition.slides).toHaveLength(3)
    expect(profile.composition.slides.map((slide) => slide.dark)).toEqual([true, false, false])
  })

  it('extracts a representative PPTX slide profile without treating it as an exact template clone', async () => {
    const style = resolveDocumentStyle({
      visualStyle: 'children',
      title: '探索自然的周末课堂',
      content: '观察、实验与分享',
      format: 'pptx'
    })
    const buffer = await createPptxBuffer(
      [
        {
          title: '探索自然的周末课堂',
          subtitle: '让好奇心带路',
          takeaway: '观察、实验与分享',
          layout: 'cover',
          accent: 'blue',
          bullets: ['自然观察', '动手实验', '表达分享']
        },
        {
          title: '每一次发现都有路径',
          layout: 'process',
          accent: 'green',
          bullets: ['观察: 发现细节', '提问: 形成假设', '实验: 验证想法']
        }
      ],
      new Map(),
      style
    )

    const profile = analyzePptxBuffer(buffer, 'children-reference.pptx', 1)

    expect(profile).toEqual(
      expect.objectContaining({
        kind: 'pptx',
        slideCount: 2,
        analyzedSlide: 1,
        aspectRatioCompatible: true,
        layoutConfidence: 'high',
        suggestedVisualStyle: 'children'
      })
    )
    expect(profile.aspectRatio).toBeCloseTo(16 / 9, 2)
    expect(profile.metrics.averageEllipseShapes).toBeGreaterThanOrEqual(2)
    expect(profile.metrics.nativeLayoutCount).toBe(1)
    expect(profile.metrics.visualLayoutDiversityRatio).toBeGreaterThan(0)
    expect(profile.metrics.averageTextUnits).toBeGreaterThan(0)
    expect(profile.designLanguage).toEqual(
      expect.objectContaining({
        paletteStrategy: expect.any(String),
        typographyScale: expect.any(String),
        shapeLanguage: expect.any(String),
        contentDensity: expect.any(String),
        targets: expect.objectContaining({ minimumTextDensityRatio: expect.any(Number) })
      })
    )
    expect(profile.headingFont).toBeTruthy()
    expect(profile.bodyFont).toBeTruthy()
    expect(profile.eastAsiaFont).toBe(style.eastAsiaFont)
    expect(new Set([profile.primaryColor, profile.secondaryColor, profile.accentColor]).size).toBe(3)
    expect([profile.primaryColor, profile.secondaryColor, profile.accentColor]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[0-9A-F]{6}$/)])
    )
    expect(profile.warnings).toEqual([])
  })

  it('detects image-heavy references and blocks a zero-picture composition match', async () => {
    const image = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#4B7751' } })
      .png()
      .toBuffer()
    const assets = new Map([
      [
        'hero',
        {
          id: 'hero',
          sourcePath: 'hero.png',
          data: image,
          width: 1280,
          height: 720,
          altText: 'Reference hero'
        }
      ]
    ])
    const style = resolveDocumentStyle({ visualStyle: 'editorial', title: 'Reference', content: '', format: 'pptx' })
    const referenceBuffer = await createPptxBuffer(
      [
        {
          title: 'Reference image story',
          layout: 'image',
          accent: 'green',
          bullets: ['Evidence'],
          imageAssetId: 'hero'
        },
        {
          title: 'Reference evidence trend',
          layout: 'chart',
          accent: 'green',
          bullets: ['Baseline | 42', 'Current | 68']
        }
      ],
      assets,
      style
    )
    const outputBuffer = await createPptxBuffer(
      [{ title: 'Text-only output', layout: 'insight', accent: 'green', bullets: ['No embedded evidence'] }],
      new Map(),
      style
    )
    const referenceProfile = analyzePptxBuffer(referenceBuffer, 'image-heavy-reference.pptx')
    const outputProfile = analyzePptxBuffer(outputBuffer, 'text-only-output.pptx')
    const comparison = comparePptxReferenceComposition(referenceProfile, outputProfile, ['insight'])

    expect(isImageHeavyPptxReference(referenceProfile)).toBe(true)
    expect(referenceProfile.metrics.pictureSlideRatio).toBe(0.5)
    expect(referenceProfile.metrics.chartSlideRatio).toBe(0.5)
    expect(outputProfile.metrics.pictureSlideRatio).toBe(0)
    expect(comparison.errors.join(' ')).toContain('contains no picture slides')
    expect(comparison.errors.join(' ')).toContain('70/100 delivery threshold')
    expect(comparison.warnings.join(' ')).toContain('no chart-oriented slide')
    expect(comparison.level).toBe('low')
  })

  it('uses an editorial photo/report rhythm strongly enough to pass the reference delivery gate', async () => {
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==',
      'base64'
    )
    const assets = new Map(
      Array.from({ length: 9 }, (_, index) => [
        `image-${index}`,
        {
          id: `image-${index}`,
          sourcePath: `image-${index}.png`,
          data: image,
          width: 1,
          height: 1,
          altText: `Topic visual ${index}`
        }
      ])
    )
    const style = resolveDocumentStyle({ visualStyle: 'editorial', title: 'New topic', content: '', format: 'pptx' })
    const seed = analyzePptxBuffer(
      await createPptxBuffer([{ title: 'Seed', layout: 'insight', accent: 'green', bullets: ['Seed'] }]),
      'seed.pptx'
    )
    const rhythm: PptxReferenceSlideArchetype[] = [
      'full-bleed-image',
      'dense-report',
      'full-bleed-image',
      'dense-report',
      'chart-report',
      'full-bleed-image',
      'dense-report',
      'full-bleed-image',
      'dense-report',
      'photo-chapter',
      'image-text',
      'full-bleed-image',
      'chart-report',
      'full-bleed-image',
      'full-bleed-image'
    ]
    const reference = {
      ...seed,
      suggestedVisualStyle: 'editorial' as const,
      suggestedMode: 'light' as const,
      metrics: {
        ...seed.metrics,
        averagePictureCoverage: 0.39,
        pictureSlideRatio: 0.6,
        chartSlideRatio: 0.133,
        averageTextBlocks: 6,
        darkSlideRatio: 0.067,
        nativeLayoutCount: 12,
        nativeLayoutDiversityRatio: 0.8,
        visualLayoutDiversityRatio: 0.8
      },
      composition: {
        slides: rhythm.map((archetype, index) => ({
          slideNumber: index + 1,
          archetype,
          dark: index === 0,
          pictureCoverage: archetype.includes('image') || archetype === 'photo-chapter' ? 0.82 : 0,
          picturePlacement:
            archetype.includes('image') || archetype === 'photo-chapter' ? ('full' as const) : ('none' as const),
          chartCount: archetype === 'chart-report' ? 1 : 0,
          textBlocks: archetype === 'dense-report' ? 9 : 4,
          textUnits: archetype === 'dense-report' ? 220 : 88,
          density: archetype === 'dense-report' ? ('dense' as const) : ('balanced' as const)
        }))
      }
    }
    const imageIndexes = new Map([
      [0, 0],
      [2, 1],
      [5, 2],
      [7, 3],
      [9, 4],
      [10, 5],
      [11, 6],
      [13, 7],
      [14, 8]
    ])
    const layouts = [
      'cover',
      'cards',
      'section',
      'insight',
      'chart',
      'section',
      'process',
      'section',
      'comparison',
      'section',
      'image',
      'section',
      'chart',
      'section',
      'summary'
    ] as const
    const slides = layouts.map((layout, index) => ({
      title: `Page ${index + 1}`,
      layout,
      accent: 'green' as const,
      bullets:
        layout === 'chart'
          ? ['Baseline | 42', 'Current | 68']
          : ['Evidence one', 'Evidence two', 'Evidence three', 'Evidence four', 'Evidence five', 'Evidence six'],
      imageAssetId: imageIndexes.has(index) ? `image-${imageIndexes.get(index)}` : undefined
    }))

    const output = analyzePptxBuffer(await createPptxBuffer(slides, assets, style, reference), 'adapted-output.pptx')
    const comparison = comparePptxReferenceComposition(
      reference,
      output,
      slides.map((slide) => slide.layout)
    )

    expect(output.metrics.pictureSlideRatio).toBeGreaterThanOrEqual(0.6)
    expect(output.metrics.darkSlideRatio).toBeLessThan(0.2)
    expect(comparison.score).toBeGreaterThanOrEqual(70)
    expect(comparison.errors).toEqual([])
  })

  it('rejects a PPTX slide number outside the reference deck', async () => {
    const buffer = await createPptxBuffer([{ title: 'Only slide', layout: 'cover', accent: 'blue', bullets: ['One'] }])

    expect(() => analyzePptxBuffer(buffer, 'one-slide.pptx', 2)).toThrow(
      'Reference slide_number must be between 1 and 1'
    )
  })

  it('scores design-language fidelity independently from package composition', async () => {
    const seed = analyzePptxBuffer(
      await createPptxBuffer([{ title: 'Reference', layout: 'cover', accent: 'blue', bullets: ['One'] }]),
      'design-language-reference.pptx'
    )
    const matching = comparePptxReferenceDesignLanguage(seed, seed)
    const contrasting = comparePptxReferenceDesignLanguage(seed, {
      ...seed,
      designLanguage: {
        ...seed.designLanguage,
        compositionBias: seed.designLanguage.compositionBias === 'left-led' ? 'right-led' : 'left-led',
        spatialRhythm: seed.designLanguage.spatialRhythm === 'compact' ? 'spacious' : 'compact',
        decorationDensity: seed.designLanguage.decorationDensity === 'rich' ? 'minimal' : 'rich',
        surfaceTreatment: seed.designLanguage.surfaceTreatment === 'photographic' ? 'flat' : 'photographic'
      }
    })

    expect(matching.score).toBe(100)
    expect(matching.level).toBe('high')
    expect(contrasting.score).toBeLessThan(70)
    expect(contrasting.warnings.join(' ')).toContain('composition bias')
  })

  it('keeps original screenshot dimensions and reports approximate visual inheritance', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-pptx-reference-image-'))
    tempDirs.push(root)
    const imagePath = path.join(root, 'reference.png')
    await sharp({
      create: { width: 1600, height: 900, channels: 3, background: '#102A43' }
    })
      .composite([
        {
          input: await sharp({
            create: { width: 900, height: 420, channels: 3, background: '#F6C453' }
          })
            .png()
            .toBuffer(),
          left: 350,
          top: 240
        }
      ])
      .png()
      .toFile(imagePath)

    const profile = await analyzePptxStyleReference(imagePath)

    expect(profile).toEqual(
      expect.objectContaining({
        kind: 'image',
        width: 1600,
        height: 900,
        aspectRatioCompatible: true,
        layoutConfidence: 'medium',
        suggestedMode: 'dark'
      })
    )
    expect(profile.aspectRatio).toBeCloseTo(16 / 9, 2)
    expect(profile.backgroundColor).toBe('202040')
    expect(profile.imageAnalysis?.activeContentRatio).toBeGreaterThan(0.15)
    expect(profile.designLanguage).toEqual(
      expect.objectContaining({
        compositionBias: expect.any(String),
        spatialRhythm: expect.any(String),
        decorationDensity: expect.any(String),
        surfaceTreatment: expect.any(String)
      })
    )
    expect(profile.warnings.join(' ')).toContain('exact geometry, fonts, icons, and master layouts are not cloned')
  })

  it('distinguishes a sparse minimal screenshot from a generic corporate layout', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-pptx-reference-minimal-'))
    tempDirs.push(root)
    const imagePath = path.join(root, 'minimal.png')
    const bars = await Promise.all(
      [180, 360, 270].map((width, index) =>
        sharp({ create: { width, height: index === 0 ? 34 : 16, channels: 3, background: '#161616' } })
          .png()
          .toBuffer()
      )
    )
    await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#FAFAFA' } })
      .composite(bars.map((input, index) => ({ input, left: 150, top: 210 + index * 90 })))
      .png()
      .toFile(imagePath)

    const profile = await analyzePptxStyleReference(imagePath)

    expect(profile.suggestedVisualStyle).toBe('minimal-light')
    expect(profile.designLanguage.spatialRhythm).toBe('spacious')
    expect(profile.designLanguage.decorationDensity).toBe('minimal')
    expect(profile.designLanguage.compositionBias).toBe('left-led')
  })

  it('recognizes a dark rectilinear technology screenshot', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-pptx-reference-tech-'))
    tempDirs.push(root)
    const imagePath = path.join(root, 'technology.png')
    const panels = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        sharp({
          create: {
            width: index < 2 ? 520 : 270,
            height: index < 2 ? 74 : 150,
            channels: 3,
            background: index % 2 ? '#16C7D9' : '#155E75'
          }
        })
          .png()
          .toBuffer()
      )
    )
    await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#071827' } })
      .composite(
        panels.map((input, index) => ({
          input,
          left: index < 2 ? 120 : 120 + ((index - 2) % 3) * 340,
          top: index < 2 ? 120 + index * 110 : 390 + Math.floor((index - 2) / 3) * 190
        }))
      )
      .png()
      .toFile(imagePath)

    const profile = await analyzePptxStyleReference(imagePath)

    expect(profile.suggestedMode).toBe('dark')
    expect(['technology', 'bold']).toContain(profile.suggestedVisualStyle)
    expect(['rectilinear', 'mixed']).toContain(profile.designLanguage.shapeLanguage)
    expect(profile.designLanguage.surfaceTreatment).not.toBe('photographic')
  })

  it('detects an editorial split screenshot with a photographic right field', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-pptx-reference-editorial-'))
    tempDirs.push(root)
    const imagePath = path.join(root, 'editorial.png')
    const photoWidth = 760
    const photoHeight = 900
    const photoPixels = Buffer.alloc(photoWidth * photoHeight * 3)
    for (let offset = 0; offset < photoPixels.length; offset += 3) {
      const pixel = offset / 3
      const x = pixel % photoWidth
      const y = Math.floor(pixel / photoWidth)
      photoPixels[offset] = (x * 17 + y * 7) % 256
      photoPixels[offset + 1] = (x * 5 + y * 13) % 256
      photoPixels[offset + 2] = (x * 11 + y * 3) % 256
    }
    const photo = await sharp(photoPixels, { raw: { width: photoWidth, height: photoHeight, channels: 3 } })
      .png()
      .toBuffer()
    const titleBar = await sharp({ create: { width: 470, height: 58, channels: 3, background: '#171717' } })
      .png()
      .toBuffer()
    const copyBar = await sharp({ create: { width: 330, height: 22, channels: 3, background: '#B42318' } })
      .png()
      .toBuffer()
    await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#F7F5F0' } })
      .composite([
        { input: photo, left: 840, top: 0 },
        { input: titleBar, left: 120, top: 240 },
        { input: copyBar, left: 120, top: 350 }
      ])
      .png()
      .toFile(imagePath)

    const profile = await analyzePptxStyleReference(imagePath)

    expect(profile.suggestedVisualStyle).toBe('editorial')
    expect(profile.designLanguage.pageRhythm).toBe('editorial')
    expect(['mixed', 'photographic']).toContain(profile.designLanguage.surfaceTreatment)
    expect(['right', 'full']).toContain(profile.composition.slides[0].picturePlacement)
  })
})
