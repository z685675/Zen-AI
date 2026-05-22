import type { FileMetadata, Provider } from '@renderer/types'
import type { TFunction } from 'i18next'
import { isEmpty } from 'lodash'

import { isGptImage2Family } from '../config/NewApiConfig'

export function checkProviderEnabled(provider: Provider, t: TFunction): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (provider.enabled && !isEmpty(provider.apiKey)) {
      resolve(true)
      return
    }

    window.modal.warning({
      content: provider.apiKey ? t('error.no_api_key') : t('error.provider_disabled'),
      centered: true,
      closable: true,
      okText: t('common.go_to_settings'),
      onOk: () => {
        window.navigate?.(`/settings/provider?id=${provider.id}`)
        reject('Provider disabled')
      },
      onCancel: () => reject('Provider disabled')
    })
  })
}

export function findPaintingByFiles<T extends { providerId?: string; files: ReadonlyArray<Pick<FileMetadata, 'id'>> }>(
  paintings: ReadonlyArray<T>,
  providerId: string,
  files: ReadonlyArray<Pick<FileMetadata, 'id'>>
): T | undefined {
  return paintings.find(
    (painting) =>
      painting.providerId === providerId &&
      painting.files.length === files.length &&
      painting.files.every((file, index) => file.id === files[index]?.id)
  )
}

export type SmartAutoSizeResult = {
  size?: string
  reason: 'explicit_size' | 'ratio_and_tier' | 'ratio_only' | 'fallback_auto' | 'conflict'
  ratio?: 'square' | 'landscape' | 'portrait'
  tier?: '2k' | '3k' | '4k'
  conflict?: 'multiple_ratios'
}

const SIZE_PATTERNS = {
  square: /方图|方形|正方形|square|1:1/i,
  squareNegative: /不要方图|不要方形|不要正方形|非方图|not square|no square/i,
  landscape: /横图|横版|宽屏|宽画幅|横向|landscape|wide|widescreen|16:9/i,
  landscapeNegative: /不要横图|不要横版|不要宽屏|非横图|not landscape|no landscape/i,
  portrait: /竖图|竖版|竖屏|纵向|portrait|vertical|9:16/i,
  portraitNegative: /不要竖图|不要竖版|不要竖屏|非竖图|not portrait|no portrait/i,
  k2: /(^|\D)2k(\D|$)|1440p/i,
  k3: /(^|\D)3k(\D|$)/i,
  k4: /(^|\D)4k(\D|$)|2160p|uhd/i
} as const

const matchesEnabledPattern = (prompt: string, positive: RegExp, negative: RegExp) => {
  return positive.test(prompt) && !negative.test(prompt)
}

export function resolveSmartAutoSize(model: string | undefined, prompt: string | undefined): SmartAutoSizeResult {
  if (!isGptImage2Family(model)) {
    return { reason: 'explicit_size' }
  }

  const normalizedPrompt = prompt?.trim()
  if (!normalizedPrompt) {
    return { reason: 'fallback_auto' }
  }

  const wantsSquare = matchesEnabledPattern(normalizedPrompt, SIZE_PATTERNS.square, SIZE_PATTERNS.squareNegative)
  const wantsLandscape = matchesEnabledPattern(
    normalizedPrompt,
    SIZE_PATTERNS.landscape,
    SIZE_PATTERNS.landscapeNegative
  )
  const wantsPortrait = matchesEnabledPattern(normalizedPrompt, SIZE_PATTERNS.portrait, SIZE_PATTERNS.portraitNegative)
  const wants4K = SIZE_PATTERNS.k4.test(normalizedPrompt)
  const wants3K = SIZE_PATTERNS.k3.test(normalizedPrompt)
  const wants2K = SIZE_PATTERNS.k2.test(normalizedPrompt)

  const matchedRatios = [
    wantsSquare ? 'square' : undefined,
    wantsLandscape ? 'landscape' : undefined,
    wantsPortrait ? 'portrait' : undefined
  ].filter(Boolean) as Array<'square' | 'landscape' | 'portrait'>

  if (matchedRatios.length > 1) {
    return {
      reason: 'conflict',
      conflict: 'multiple_ratios',
      tier: wants4K ? '4k' : wants3K ? '3k' : wants2K ? '2k' : undefined
    }
  }

  const ratio = matchedRatios[0]
  const tier = wants4K ? '4k' : wants3K ? '3k' : wants2K ? '2k' : undefined

  if (ratio === 'square') {
    if (tier === '4k' || tier === '3k') {
      return { size: '2880x2880', reason: 'ratio_and_tier', ratio, tier }
    }
    if (tier === '2k') {
      return { size: '2048x2048', reason: 'ratio_and_tier', ratio, tier }
    }
    return { size: '1024x1024', reason: 'ratio_only', ratio }
  }

  if (ratio === 'landscape') {
    if (tier === '4k') {
      return { size: '3840x2048', reason: 'ratio_and_tier', ratio, tier }
    }
    if (tier === '3k') {
      return { size: '3072x2048', reason: 'ratio_and_tier', ratio, tier }
    }
    if (tier === '2k') {
      return { size: '2560x1440', reason: 'ratio_and_tier', ratio, tier }
    }
    return { size: '1536x1024', reason: 'ratio_only', ratio }
  }

  if (ratio === 'portrait') {
    if (tier === '4k') {
      return { size: '2048x3840', reason: 'ratio_and_tier', ratio, tier }
    }
    if (tier === '3k') {
      return { size: '2048x3072', reason: 'ratio_and_tier', ratio, tier }
    }
    if (tier === '2k') {
      return { size: '1440x2560', reason: 'ratio_and_tier', ratio, tier }
    }
    return { size: '1024x1536', reason: 'ratio_only', ratio }
  }

  return { reason: 'fallback_auto', tier }
}
