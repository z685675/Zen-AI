import { describe, expect, it } from 'vitest'

import type { ImageCanvasRequest } from '../imageCanvas'
import {
  configuredImageCapabilities,
  defaultImageCapabilities,
  imageDimension,
  validateImageCapabilities
} from '../imageCapabilities'

const input = (size = '1024x1024', aspectRatio = '1:1'): ImageCanvasRequest => ({
  id: '',
  providerId: 'p',
  modelId: 'gpt-image-2',
  prompt: 'test',
  references: [],
  size,
  aspectRatio,
  count: 1,
  quality: 'auto',
  background: 'auto'
})

describe('image model capability contracts', () => {
  it('offers common ratios and pixel sizes while treating them as upstream preferences', () => {
    const capabilities = defaultImageCapabilities({ id: 'gpt-image-2', name: 'Image', protocol: 'openai' })
    for (const size of ['1024x1024', '2048x2048', '4096x4096', '4096x2304'])
      expect(capabilities.dimensions.some((item) => item.size === size)).toBe(true)
    expect(capabilities.dimensions.some((item) => item.ratio === '21:9')).toBe(true)
    expect(() => validateImageCapabilities(input('4096x2304', '16:9'), capabilities)).not.toThrow()
  })

  it('keeps legacy and newer native Qwen model capabilities separate', () => {
    const caps = (id: string) => defaultImageCapabilities({ id, name: id, protocol: 'dashscope' })
    expect(caps('qwen-image').dimensions[0].size).toBe('1328x1328')
    expect(caps('qwen-image').maxReferences).toBe(0)
    expect(caps('qwen-image-edit')).toMatchObject({
      minReferences: 1,
      maxReferences: 3,
      dimensions: [{ ratio: 'auto', size: 'auto' }]
    })
    expect(caps('qwen-image-3.0').dimensions[0].size).toBe('auto')
    expect(caps('wanx2.1-imageedit')).toMatchObject({ minReferences: 1, maxReferences: 1, supportsMask: true })
  })
  it('uses exact dimensions and rejects an unsupported 16:9 request instead of changing it to 3:2', () => {
    const capabilities = defaultImageCapabilities({ id: 'gpt-image-2', name: 'Image', protocol: 'openai' })
    expect(imageDimension('1536x1024').ratio).toBe('3:2')
    expect(() => validateImageCapabilities(input('1536x1024', '16:9'), capabilities)).toThrow(
      'image_dimensions_unsupported'
    )
    expect(() => validateImageCapabilities(input(), capabilities)).not.toThrow()
  })
  it('requires explicit capabilities for unknown aliases and checks reference counts', () => {
    const capabilities = defaultImageCapabilities({ id: 'my-alias', name: 'Image', protocol: 'openai' })
    expect(capabilities.maxReferences).toBe(0)
    expect(() =>
      validateImageCapabilities({ ...input('auto', 'auto'), references: ['reference'] }, capabilities)
    ).toThrow('image_reference_or_count_unsupported')
  })
  it('builds a native ratio/resolution matrix and rejects unsafe custom options', () => {
    const settings = {
      protocol: 'gemini' as const,
      sizes: [],
      ratios: ['16:9'],
      resolutions: ['2K' as const],
      qualities: [],
      backgrounds: [],
      minReferences: 1,
      maxReferences: 3,
      maxImages: 1
    }
    const capabilities = configuredImageCapabilities(settings)
    expect(capabilities.dimensions).toEqual([{ ratio: '16:9', size: '16:9', resolution: '2K' }])
    expect(() => configuredImageCapabilities({ ...settings, maxImages: 4 })).toThrow('invalid_capabilities')
    expect(() => configuredImageCapabilities({ ...settings, maxReferences: 50 })).toThrow('invalid_capabilities')
    expect(() => validateImageCapabilities({ ...input('16:9', '16:9'), resolution: '2K' }, capabilities)).toThrow(
      'image_reference_or_count_unsupported'
    )
  })
})
