import '../../../../../../packages/image-workbench/src/i18n'

import type { ImageCanvasDimension } from '@shared/config/imageCanvas'
import i18next from 'i18next'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  dimensionKey,
  imageDimensionLabel,
  orderedImageDimensions
} from '../../../../../../packages/image-workbench/src/imageDimensions'

beforeEach(async () => {
  await i18next.changeLanguage('zh')
})

describe('workbench image size options', () => {
  it.each<[ImageCanvasDimension, string]>([
    [{ ratio: 'auto', size: 'auto' }, '自动（智能匹配）'],
    [{ ratio: '1:1', size: '1024x1024' }, '方图 1024 × 1024'],
    [{ ratio: '2:3', size: '1024x1536' }, '竖图 1024 × 1536'],
    [{ ratio: '3:2', size: '1536x1024' }, '横图 1536 × 1024'],
    [{ ratio: '9:16', size: '9:16', resolution: '2K' }, '竖图 9:16 · 2K'],
    [{ ratio: '16:9', size: '16:9', resolution: '4K' }, '横图 16:9 · 4K'],
    [{ ratio: '1:1', size: '1:1' }, '方图 1:1 · 自动分辨率'],
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
      '["auto","auto","4K"]',
      '["1:1","1024x1024",""]'
    ])
    expect(dimensions).toEqual(original)
  })

  it('does not invent auto sizing for an interface limited to fixed pixels', () => {
    const dimensions = [{ ratio: '1:1', size: '512x512' }]
    expect(orderedImageDimensions(dimensions)).toEqual(dimensions)
    expect(orderedImageDimensions([])).toEqual([])
  })
})
