import type { ImageFileMetadata } from '@types'
import { readFile } from 'fs/promises'

export type OcrPreprocessMode = 'auto' | 'high-contrast' | 'none'

const MAX_OCR_PIXELS = 50_000_000
const TARGET_MIN_WIDTH = 1600

export const preprocessOcrImage = async (buffer: Buffer, mode: OcrPreprocessMode = 'auto'): Promise<Buffer> => {
  // Delayed loading: The Sharp module is only loaded when the OCR functionality is actually needed, not at app startup
  const sharp = (await import('sharp')).default
  const source = sharp(buffer, { failOn: 'warning', limitInputPixels: MAX_OCR_PIXELS }).autoOrient()
  const metadata = await source.metadata()
  if (!metadata.width || !metadata.height) throw new Error('OCR image dimensions are unavailable')

  const orientedWidth = metadata.autoOrient?.width ?? metadata.width
  const orientedHeight = metadata.autoOrient?.height ?? metadata.height
  const desiredScale = orientedWidth < TARGET_MIN_WIDTH ? Math.min(2, TARGET_MIN_WIDTH / orientedWidth) : 1
  const pixelSafeScale = Math.sqrt(MAX_OCR_PIXELS / (orientedWidth * orientedHeight))
  const scale = Math.max(1, Math.min(desiredScale, pixelSafeScale))
  let pipeline = source.flatten({ background: '#ffffff' }).resize({
    width: Math.round(orientedWidth * scale),
    height: Math.round(orientedHeight * scale),
    fit: 'fill',
    kernel: 'lanczos3'
  })

  if (mode !== 'none') {
    pipeline = pipeline.grayscale().normalize({ lower: 2, upper: 98 }).sharpen({ sigma: 0.8 })
  }
  if (mode === 'high-contrast') pipeline = pipeline.threshold()

  return pipeline.png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer()
}

/**
 * 加载并预处理OCR图像
 * @param file - 图像文件元数据
 * @returns 预处理后的图像Buffer
 * @throws {Error} 当文件不存在或无法读取时抛出错误；当图像预处理失败时抛出错误
 *
 * 预处理步骤:
 * 1. 读取图像文件
 * 2. 转换为灰度图
 * 3. 后续可扩展其他预处理步骤
 */
export const loadOcrImage = async (file: ImageFileMetadata, mode: OcrPreprocessMode = 'auto'): Promise<Buffer> => {
  const buffer = await readFile(file.path)
  return preprocessOcrImage(buffer, mode)
}
