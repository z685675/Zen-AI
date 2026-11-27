import type { LegacyImageRecord } from '@shared/config/imageCanvas'

import { fetchPublicHttpsResult } from '../../mcpServers/publicWebNetwork'
import type { ImageCanvasTaskStore } from './TaskStore'

const maxBytes = 40 * 1024 * 1024

type ReadStoredFile = (name: string, maxBytes: number) => Promise<Buffer>

async function readLegacyImage(
  { name, url }: LegacyImageRecord['assets'][number],
  readStoredFile: ReadStoredFile
): Promise<Buffer> {
  if (name) {
    try {
      return await readStoredFile(name, maxBytes)
    } catch (error) {
      if (!url) throw error
    }
  }
  if (url?.startsWith('data:image/')) {
    const match = /^data:image\/[\w.+-]+;base64,([\w+/=]+)$/.exec(url)
    if (match && match[1].length <= Math.ceil((maxBytes * 4) / 3) + 4) return Buffer.from(match[1], 'base64')
  }
  if (!url?.startsWith('https://')) throw new Error('legacy_image_unavailable')
  const response = await fetchPublicHttpsResult(url, AbortSignal.timeout(15_000))
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw new Error('legacy_image_unavailable')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, length)
      length += value.byteLength
      if (length > maxBytes) throw new Error('legacy_image_too_large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export async function importLegacyImages(
  store: ImageCanvasTaskStore,
  records: LegacyImageRecord[],
  readStoredFile: ReadStoredFile
): Promise<number> {
  if (!Array.isArray(records) || records.length > 20) throw new Error('invalid_legacy_records')
  let missing = 0
  for (const record of records) {
    if (
      !record ||
      typeof record.id !== 'string' ||
      record.id.length > 250 ||
      typeof record.prompt !== 'string' ||
      !Array.isArray(record.assets)
    )
      throw new Error('invalid_legacy_record')
    missing += await store.importLegacy(record, (source) => readLegacyImage(source, readStoredFile))
  }
  return missing
}
