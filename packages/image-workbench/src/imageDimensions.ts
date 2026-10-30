import type { ImageCanvasDimension } from '@shared/config/imageCanvas'
import { imageDimension } from '@shared/config/imageCapabilities'
import { commonImageSizePresets } from '@shared/config/imageSizePresets'
import type { TFunction } from 'i18next'

export function dimensionKey(dimension: ImageCanvasDimension): string {
  return JSON.stringify([dimension.ratio, dimension.size, dimension.resolution || ''])
}

export function orderedImageDimensions(
  dimensions: ImageCanvasDimension[],
  selectedKey?: string
): ImageCanvasDimension[] {
  const hasPixels = dimensions.some((item) => /^\d+x\d+$/.test(item.size))
  const preferred = commonImageSizePresets.flatMap(({ size }) => {
    if (size === 'auto') {
      const automatic = dimensions.find((item) => item.size === 'auto' && item.ratio === 'auto' && !item.resolution)
      return automatic ? [automatic] : []
    }
    const preset = imageDimension(size)
    const longestSide = Math.max(...size.split('x').map(Number))
    const resolution = longestSide <= 1536 ? '1K' : longestSide <= 2560 ? '2K' : '4K'
    const match = dimensions.find((item) =>
      hasPixels
        ? item.size === size && !item.resolution
        : item.ratio === preset.ratio && item.size === preset.ratio && item.resolution === resolution
    )
    // Some native interfaces only accept ratios, without a resolution field.
    const ratioOnly = !hasPixels && dimensions.find((item) => item.ratio === preset.ratio && !item.resolution)
    return match ? [match] : ratioOnly ? [ratioOnly] : []
  })
  // Fixed-size/custom interfaces must remain usable even without common presets.
  const options = preferred.some((item) => item.size !== 'auto')
    ? preferred
    : [
        ...dimensions.filter((item) => item.size === 'auto' && item.ratio === 'auto' && !item.resolution),
        ...dimensions.filter((item) => item.size !== 'auto' || item.ratio !== 'auto' || item.resolution)
      ]
  const selected = dimensions.find((item) => dimensionKey(item) === selectedKey)
  // Keep a reused/saved legacy size visible without repopulating the whole list.
  return [...new Map([...options, ...(selected ? [selected] : [])].map((item) => [dimensionKey(item), item])).values()]
}

export function imageDimensionLabel(dimension: ImageCanvasDimension, t: TFunction): string {
  const pixels = /^(\d+)x(\d+)$/.exec(dimension.size)
  const preset = commonImageSizePresets.find((item) => item.size === dimension.size)
  if (pixels && preset) {
    const labelKey = `imageSizes.${preset.size}`
    return `${t(labelKey)}${preset.isExperimental ? ` ${t('highCost')}` : ''}`
  }
  const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(dimension.ratio)
  const shape = pixels || ratio
  if (!shape) {
    const resolution = dimension.resolution || (dimension.size !== 'auto' ? dimension.size : '')
    return `${t('autoMatch')}${resolution ? ` · ${resolution}` : ''}`
  }
  const width = Number(shape[1]),
    height = Number(shape[2])
  const orientation = t(width === height ? 'squareImage' : width > height ? 'landscapeImage' : 'portraitImage')
  // Native ratio-based APIs do not promise exact pixels; never invent a resolution.
  return pixels
    ? `${orientation} · ${width} × ${height}`
    : `${dimension.resolution ? `${dimension.resolution} ` : ''}${orientation} · ${dimension.ratio}${dimension.resolution ? '' : ` · ${t('autoResolution')}`}`
}
