import { describe, expect, it } from 'vitest'

import { resolveSmartAutoSize } from '../index'

describe('resolveSmartAutoSize', () => {
  it('keeps fallback auto when prompt is empty', () => {
    expect(resolveSmartAutoSize('gpt-image-2', '').reason).toBe('fallback_auto')
  })

  it('maps 4k landscape prompts to the highest legal landscape preset', () => {
    expect(resolveSmartAutoSize('gpt-image-2', '请生成 4K 宽屏横版电影海报')).toEqual({
      ratio: 'landscape',
      size: '3840x2048',
      reason: 'ratio_and_tier',
      tier: '4k'
    })
  })

  it('maps 4k portrait prompts to the highest legal portrait preset', () => {
    expect(resolveSmartAutoSize('gpt-image-2', '4K 竖版时尚封面')).toEqual({
      ratio: 'portrait',
      size: '2048x3840',
      reason: 'ratio_and_tier',
      tier: '4k'
    })
  })

  it('maps square high-resolution prompts to the legal square cap', () => {
    expect(resolveSmartAutoSize('gpt-image-2', '3K 方图头像写真')).toEqual({
      ratio: 'square',
      size: '2880x2880',
      reason: 'ratio_and_tier',
      tier: '3k'
    })
  })

  it('maps ratio-only prompts to a matching default preset', () => {
    expect(resolveSmartAutoSize('gpt-image-2', '一张宽屏横图电影感人像')).toEqual({
      ratio: 'landscape',
      size: '1536x1024',
      reason: 'ratio_only'
    })
  })

  it('does not treat negated square wording as a square request', () => {
    expect(resolveSmartAutoSize('gpt-image-2', '请生成 4K 竖图，不要方图，不要横图')).toEqual({
      ratio: 'portrait',
      size: '2048x3840',
      reason: 'ratio_and_tier',
      tier: '4k'
    })
  })

  it('falls back when prompt contains conflicting ratio instructions', () => {
    expect(resolveSmartAutoSize('gpt-image-2', '请生成 4K 横图，同时要竖版封面')).toEqual({
      reason: 'conflict',
      conflict: 'multiple_ratios',
      tier: '4k'
    })
  })

  it('also applies smart auto mapping to gpt-image-2-pro', () => {
    expect(resolveSmartAutoSize('gpt-image-2-pro', '4K 竖版时尚封面')).toEqual({
      ratio: 'portrait',
      size: '2048x3840',
      reason: 'ratio_and_tier',
      tier: '4k'
    })
  })

  it('also applies smart auto mapping to gpt-image-2-vip', () => {
    expect(resolveSmartAutoSize('gpt-image-2-vip', '4K 宽屏横版电影海报')).toEqual({
      ratio: 'landscape',
      size: '3840x2048',
      reason: 'ratio_and_tier',
      tier: '4k'
    })
  })

  it('does not change other models', () => {
    expect(resolveSmartAutoSize('gpt-image-1', '4K 横图')).toEqual({
      reason: 'explicit_size'
    })
  })
})
