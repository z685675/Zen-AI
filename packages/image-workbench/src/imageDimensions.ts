import type { ImageCanvasDimension } from '@shared/config/imageCanvas'
import type { TFunction } from 'i18next'

export function dimensionKey(dimension: ImageCanvasDimension): string {
  return JSON.stringify([dimension.ratio, dimension.size, dimension.resolution || ''])
}

export function orderedImageDimensions(dimensions: ImageCanvasDimension[]): ImageCanvasDimension[] {
  // The default must mean automatic sizing, not an implicit 1K/2K/4K choice.
  return [
    ...dimensions.filter((item) => item.size === 'auto' && item.ratio === 'auto' && !item.resolution),
    ...dimensions.filter((item) => item.size !== 'auto' || item.ratio !== 'auto' || item.resolution)
  ]
}

export function imageDimensionLabel(dimension: ImageCanvasDimension, t: TFunction): string {
  const pixels = /^(\d+)x(\d+)$/.exec(dimension.size)
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
    ? `${orientation} ${width} × ${height}`
    : `${orientation} ${dimension.ratio} · ${dimension.resolution || t('autoResolution')}`
}
