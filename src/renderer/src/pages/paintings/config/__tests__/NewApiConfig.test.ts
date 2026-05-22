import { describe, expect, it } from 'vitest'

import { getModelConfig, resolveModelConfig } from '../NewApiConfig'

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

  it('removes transparent background from gpt-image-2', () => {
    const gptImage2 = getModelConfig('gpt-image-2')

    expect(gptImage2?.background.map((option) => option.value)).toEqual(['auto', 'opaque'])
  })

  it('reuses gpt-image-2 capabilities for gpt-image-2-pro', () => {
    const gptImage2Pro = getModelConfig('gpt-image-2-pro')

    expect(gptImage2Pro?.imageSizes.map((option) => option.value)).toEqual(
      getModelConfig('gpt-image-2')?.imageSizes.map((option) => option.value)
    )
    expect(gptImage2Pro?.background.map((option) => option.value)).toEqual(['auto', 'opaque'])
  })

  it('reuses gpt-image-2 capabilities for gpt-image-2-vip', () => {
    const gptImage2Vip = getModelConfig('gpt-image-2-vip')

    expect(gptImage2Vip?.imageSizes.map((option) => option.value)).toEqual(
      getModelConfig('gpt-image-2')?.imageSizes.map((option) => option.value)
    )
    expect(gptImage2Vip?.background.map((option) => option.value)).toEqual(['auto', 'opaque'])
  })
})
