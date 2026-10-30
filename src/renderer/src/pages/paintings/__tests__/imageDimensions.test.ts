import '../../../../../../packages/image-workbench/src/i18n'

import type { ImageCanvasDimension } from '@shared/config/imageCanvas'
import { defaultImageCapabilities, imageDimension } from '@shared/config/imageCapabilities'
import { commonImageSizePresets } from '@shared/config/imageSizePresets'
import i18next from 'i18next'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  dimensionKey,
  imageDimensionLabel,
  orderedImageDimensions
} from '../../../../../../packages/image-workbench/src/imageDimensions'
import en from '../../../i18n/locales/en-us.json'
import zh from '../../../i18n/locales/zh-cn.json'

beforeEach(async () => {
  await i18next.changeLanguage('zh')
})

describe('workbench image size options', () => {
  it.each<[ImageCanvasDimension, string]>([
    [{ ratio: 'auto', size: 'auto' }, '自动（智能匹配）'],
    [{ ratio: '1:1', size: '1024x1024' }, '方图 · 1024 × 1024'],
    [{ ratio: '2:3', size: '1024x1536' }, '竖图 · 1024 × 1536'],
    [{ ratio: '3:2', size: '1536x1024' }, '横图 · 1536 × 1024'],
    [{ ratio: '9:16', size: '9:16', resolution: '2K' }, '2K 竖图 · 9:16'],
    [{ ratio: '16:9', size: '16:9', resolution: '4K' }, '4K 横图 · 16:9'],
    [{ ratio: '1:1', size: '1:1' }, '方图 · 1:1 · 自动分辨率'],
    [{ ratio: 'auto', size: 'auto', resolution: '1K' }, '自动（智能匹配） · 1K']
  ])('labels %j without inventing output pixels', (dimension, expected) => {
    expect(imageDimensionLabel(dimension, i18next.t)).toBe(expected)
  })

  it('puts unrestricted auto first without changing capability objects or their request keys', () => {
    const dimensions: ImageCanvasDimension[] = [
      { ratio: 'auto', size: 'auto', resolution: '4K' },
      { ratio: '1:1', size: '1024x1024' },
      { ratio: 'auto', size: 'auto' }
    ]
    const original = structuredClone(dimensions)
    expect(orderedImageDimensions(dimensions).map(dimensionKey)).toEqual([
      '["auto","auto",""]',
      '["1:1","1024x1024",""]'
    ])
    expect(dimensions).toEqual(original)
  })

  it.each([
    ['zh', zh],
    ['en', en]
  ] as const)('copies local image sizes, order and labels exactly in %s', async (language, translations) => {
    await i18next.changeLanguage(language)
    const capabilities = defaultImageCapabilities({ id: 'gpt-image-2', name: 'Image', protocol: 'openai' })
    const visible = orderedImageDimensions([...capabilities.dimensions].reverse())
    expect(visible.map((item) => item.size)).toEqual(commonImageSizePresets.map((item) => item.size))
    expect(visible).toHaveLength(12)
    const labels = translations.paintings.image_size_options
    expect(visible.map((item) => imageDimensionLabel(item, i18next.t))).toEqual(
      commonImageSizePresets.map((item) => {
        const label = labels[item.size as keyof typeof labels]
        return `${label}${item.isExperimental ? ` ${labels.experimental_badge}` : ''}`
      })
    )
  })

  it('keeps only a selected legacy size in addition to the common choices', () => {
    const capabilities = defaultImageCapabilities({ id: 'gpt-image-2', name: 'Image', protocol: 'openai' })
    const legacy = imageDimension('4096x2304')
    const visible = orderedImageDimensions(capabilities.dimensions, dimensionKey(legacy))
    expect(visible.map((item) => item.size)).toEqual([...commonImageSizePresets.map((item) => item.size), legacy.size])
    expect(orderedImageDimensions(capabilities.dimensions).map((item) => item.size)).not.toContain(legacy.size)
    expect(orderedImageDimensions(capabilities.dimensions, 'missing')).toHaveLength(12)
  })

  it('compacts native ratio/resolution options without inventing exact pixels or native 3K', () => {
    const capabilities = defaultImageCapabilities({ id: 'gemini-image', name: 'Image', protocol: 'gemini' })
    const visible = orderedImageDimensions(capabilities.dimensions)
    expect(visible).toHaveLength(12)
    expect(visible[0]).toEqual({ ratio: 'auto', size: 'auto' })
    expect(visible.every((item) => capabilities.dimensions.includes(item))).toBe(true)
    expect(visible.map(dimensionKey)).toContain('["16:9","16:9","4K"]')
    expect(visible.some((item) => item.ratio === '21:9')).toBe(false)
    const legacy = { ratio: '21:9', size: '21:9', resolution: '2K' as const }
    expect(orderedImageDimensions(capabilities.dimensions, dimensionKey(legacy))).toHaveLength(13)
  })

  it('deduplicates native ratio-only choices and retains custom-only interfaces', () => {
    const native = ['1:1', '3:2', '2:3', '16:9', '9:16'].map((ratio) => ({ ratio, size: ratio }))
    expect(orderedImageDimensions([...native].reverse())).toEqual(native)
    const custom = [imageDimension('auto'), imageDimension('1328x1328'), imageDimension('1664x928')]
    expect(orderedImageDimensions(custom)).toEqual(custom)
  })

  it('does not invent auto sizing for an interface limited to fixed pixels', () => {
    const dimensions = [{ ratio: '1:1', size: '512x512' }]
    expect(orderedImageDimensions(dimensions)).toEqual(dimensions)
    expect(orderedImageDimensions([])).toEqual([])
  })
})
