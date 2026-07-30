import fsp from 'node:fs/promises'

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import sharp from 'sharp'

const MAX_IMAGE_ASSET_BYTES = 25 * 1024 * 1024
const MAX_TOTAL_IMAGE_ASSET_BYTES = 75 * 1024 * 1024
const MAX_IMAGE_ASSET_PIXELS = 40_000_000
const MAX_TOTAL_IMAGE_ASSET_PIXELS = 100_000_000
const MAX_TOTAL_NORMALIZED_IMAGE_BYTES = 100 * 1024 * 1024
const MAX_IMAGE_ASSETS = 24
const IMAGE_ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const IMAGE_REFERENCE_PATTERN = /!\[([^\]]*)\]\(asset:([A-Za-z0-9][A-Za-z0-9._-]{0,63})\)/g

export interface ImageAssetInput {
  id?: string
  file_path?: string
  alt_text?: string
}

export interface LoadedImageAsset {
  id: string
  sourcePath: string
  data: Buffer
  width: number
  height: number
  altText: string
}

export interface ImageAssetReference {
  id: string
  altText: string
}

export async function loadImageAssets(
  inputs: ImageAssetInput[] | undefined,
  resolveInputPath: (filePath: string) => string
): Promise<Map<string, LoadedImageAsset>> {
  if (inputs === undefined) return new Map()
  if (!Array.isArray(inputs)) throw invalidParams("'assets' must be an array")
  if (inputs.length > MAX_IMAGE_ASSETS) {
    throw invalidParams(`At most ${MAX_IMAGE_ASSETS} image assets can be embedded in one file`)
  }

  const assets = new Map<string, LoadedImageAsset>()
  let totalSourceBytes = 0
  let totalPixels = 0
  let totalNormalizedBytes = 0

  for (const [index, input] of inputs.entries()) {
    const id = typeof input?.id === 'string' ? input.id.trim() : ''
    const filePath = typeof input?.file_path === 'string' ? input.file_path.trim() : ''
    if (!IMAGE_ASSET_ID_PATTERN.test(id)) {
      throw invalidParams(
        `assets[${index}].id must be 1-64 characters using letters, numbers, dot, underscore, or hyphen`
      )
    }
    if (!filePath) throw invalidParams(`assets[${index}].file_path is required`)
    if (assets.has(id)) throw invalidParams(`Duplicate image asset id: ${id}`)

    const sourcePath = resolveInputPath(filePath)
    let stat
    try {
      stat = await fsp.stat(sourcePath)
    } catch (error) {
      throw invalidParams(`Image asset '${id}' cannot be read: ${errorMessage(error)}`)
    }
    if (!stat.isFile()) throw invalidParams(`Image asset '${id}' is not a file: ${sourcePath}`)
    if (stat.size <= 0) throw invalidParams(`Image asset '${id}' is empty`)
    if (stat.size > MAX_IMAGE_ASSET_BYTES) {
      throw invalidParams(`Image asset '${id}' exceeds the ${MAX_IMAGE_ASSET_BYTES / 1024 / 1024}MB limit`)
    }
    totalSourceBytes += stat.size
    if (totalSourceBytes > MAX_TOTAL_IMAGE_ASSET_BYTES) {
      throw invalidParams(`Image assets exceed the ${MAX_TOTAL_IMAGE_ASSET_BYTES / 1024 / 1024}MB total limit`)
    }

    const source = await fsp.readFile(sourcePath)
    try {
      const pipeline = sharp(source, {
        animated: false,
        failOn: 'warning',
        limitInputPixels: MAX_IMAGE_ASSET_PIXELS
      }).autoOrient()
      const metadata = await pipeline.metadata()
      if (!metadata.width || !metadata.height) throw new Error('image dimensions are unavailable')
      if (metadata.pages && metadata.pages > 1) throw new Error('animated or multipage images are not supported')
      totalPixels += metadata.width * metadata.height
      if (totalPixels > MAX_TOTAL_IMAGE_ASSET_PIXELS) {
        throw new Error(`image assets exceed the ${MAX_TOTAL_IMAGE_ASSET_PIXELS.toLocaleString()} total pixel limit`)
      }

      const { data, info } = await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({
        resolveWithObject: true
      })
      totalNormalizedBytes += data.length
      if (totalNormalizedBytes > MAX_TOTAL_NORMALIZED_IMAGE_BYTES) {
        throw new Error(`normalized image assets exceed the ${MAX_TOTAL_NORMALIZED_IMAGE_BYTES / 1024 / 1024}MB limit`)
      }
      assets.set(id, {
        id,
        sourcePath,
        data,
        width: info.width,
        height: info.height,
        altText: typeof input.alt_text === 'string' && input.alt_text.trim() ? input.alt_text.trim() : `Image ${id}`
      })
    } catch (error) {
      throw invalidParams(`Image asset '${id}' is unsupported or invalid: ${errorMessage(error)}`)
    }
  }

  return assets
}

export function findImageAssetReferences(content: string): ImageAssetReference[] {
  const references: ImageAssetReference[] = []
  for (const match of content.matchAll(IMAGE_REFERENCE_PATTERN)) {
    references.push({ id: match[2], altText: match[1].trim() })
  }
  return references
}

export function validateImageAssetUsage(
  assets: Map<string, LoadedImageAsset>,
  content: string,
  slideAssetIds: Array<string | undefined>
): { usedAssetIds: string[]; unusedAssetIds: string[] } {
  const used = new Set(findImageAssetReferences(content).map((reference) => reference.id))
  for (const assetId of slideAssetIds) {
    if (assetId) used.add(assetId)
  }

  for (const id of used) {
    if (!assets.has(id)) throw invalidParams(`Image content references missing asset: ${id}`)
  }

  return {
    usedAssetIds: [...used],
    unusedAssetIds: [...assets.keys()].filter((id) => !used.has(id))
  }
}

export function fitImageWithin(
  asset: Pick<LoadedImageAsset, 'width' | 'height'>,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  const scale = Math.min(maxWidth / asset.width, maxHeight / asset.height, 1)
  return {
    width: Math.max(1, Math.round(asset.width * scale)),
    height: Math.max(1, Math.round(asset.height * scale))
  }
}

function invalidParams(message: string) {
  return new McpError(ErrorCode.InvalidParams, message)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
