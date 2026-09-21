import { describe, expect, it } from 'vitest'

import { getModelConfig, isGptImage2Family, isGrokImagineFamily, resolveModelConfig } from '../NewApiConfig'

const parseSize = (size: string) => {
  const [width, height] = size.split('x').map(Number)
  return { width, height }
}

describe('NewApiConfig', () => {
  it('keeps gpt-image-1 legacy sizes unchanged', () => {
    const gptImage1 = getModelConfig('gpt-image-1')

    expect(gptImage1?.imageSizes.map((option) => option.value)).toEqual(['auto', '1024x1024', '1536x1024', '1024x1536'])
  })

  it('uses fallback config for unknown models', () => {
    expect(resolveModelConfig('unknown-model').name).toBe('gpt-image-1')
  })

  it('recognizes dated and gateway-prefixed gpt-image-2 model IDs', () => {
    expect(resolveModelConfig('gpt-image-2-2026-04-21').name).toBe('gpt-image-2')
    expect(resolveModelConfig('openai/gpt-image-2-2026-04-21').name).toBe('gpt-image-2')
  })

  it.each([
    'gpt-image2.5',
    'gpt-image-2.5',
    'gpt-image2.5-2026-09-01',
    'openai/gpt-image2.5-2026-09-01',
    'openai/gpt-image-2.5'
  ])('recognizes gpt-image2.5 model IDs from direct and gateway routes: %s', (modelId) => {
    expect(isGptImage2Family(modelId)).toBe(true)
    expect(resolveModelConfig(modelId).name).toMatch(/^gpt-image(?:-)?2(?:\.5|-|$)/)
    expect(resolveModelConfig(modelId).imageSizes).toEqual(getModelConfig('gpt-image-2')?.imageSizes)
  })

  it('uses the official automatic moderation default for gpt-image-2', () => {
    const gptImage2 = getModelConfig('gpt-image-2')

    expect(gptImage2?.moderation[0]?.value).toBe('auto')
  })

  it.each([
    'grok-imagine-image',
    'grok-imagine-image-2.0',
    'grok-imagine-image-2026-03-02',
    'xai/grok-imagine-image-2.0',
    'grok-imagine-image-quality-latest'
  ])('recognizes Grok Imagine model IDs: %s', (modelId) => {
    expect(isGrokImagineFamily(modelId)).toBe(true)
  })

  it('uses Grok Imagine native request settings for the latest model', () => {
    const grokImagine = resolveModelConfig('grok-imagine-image-2.0')

    expect(grokImagine.requestProtocol).toBe('grok-imagine')
    expect(grokImagine.imageInputLimit).toBe(5)
    expect(grokImagine.imageSizes.map((option) => option.value)).toEqual(['1k', '2k'])
    expect(grokImagine.aspectRatios?.map((option) => option.value)).toContain('21:9')
    expect(grokImagine.quality.map((option) => option.value)).toEqual(['auto', 'low', 'medium'])
    expect(grokImagine.moderation).toEqual([])
    expect(grokImagine.background).toEqual([])
  })

  it('provides only valid official gpt-image-2 preset sizes', () => {
    const gptImage2 = getModelConfig('gpt-image-2')

    expect(gptImage2).toBeDefined()

    for (const option of gptImage2!.imageSizes) {
      if (option.value === 'auto') {
        continue
      }

      const { width, height } = parseSize(option.value)
      const longerSide = Math.max(width, height)
      const shorterSide = Math.min(width, height)
      const pixels = width * height

      expect(width % 16).toBe(0)
      expect(height % 16).toBe(0)
      expect(longerSide).toBeLessThanOrEqual(3840)
      expect(longerSide / shorterSide).toBeLessThanOrEqual(3)
      expect(pixels).toBeGreaterThanOrEqual(655_360)
      expect(pixels).toBeLessThanOrEqual(8_294_400)
    }
  })

  it('exposes all background choices for gpt-image-2', () => {
    const gptImage2 = getModelConfig('gpt-image-2')

    expect(gptImage2?.background.map((option) => option.value)).toEqual(['auto', 'opaque', 'transparent'])
  })

  it('exposes the supported non-GIF output formats for gpt-image-2', () => {
    const gptImage2 = getModelConfig('gpt-image-2')

    expect(gptImage2?.output_format.map((option) => option.value)).toEqual(['png', 'jpeg', 'webp'])
  })

  it('reuses gpt-image-2 capabilities for gpt-image-2-pro', () => {
    const gptImage2Pro = getModelConfig('gpt-image-2-pro')

    expect(gptImage2Pro?.imageSizes.map((option) => option.value)).toEqual(
      getModelConfig('gpt-image-2')?.imageSizes.map((option) => option.value)
    )
    expect(gptImage2Pro?.background.map((option) => option.value)).toEqual(['auto', 'opaque', 'transparent'])
  })

  it('reuses gpt-image-2 capabilities for gpt-image-2-vip', () => {
    const gptImage2Vip = getModelConfig('gpt-image-2-vip')

    expect(gptImage2Vip?.imageSizes.map((option) => option.value)).toEqual(
      getModelConfig('gpt-image-2')?.imageSizes.map((option) => option.value)
    )
    expect(gptImage2Vip?.background.map((option) => option.value)).toEqual(['auto', 'opaque', 'transparent'])
  })
})
