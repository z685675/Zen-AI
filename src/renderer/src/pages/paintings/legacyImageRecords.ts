import FileManager from '@renderer/services/FileManager'
import type { PaintingAction, PaintingsState } from '@renderer/types'
import type { LegacyImageRecord } from '@shared/config/imageCanvas'

export function legacyImageRecords(state: PaintingsState): LegacyImageRecord[] {
  const records = new Map<string, LegacyImageRecord>()
  for (const series of [state.openai_image_generate, ...Object.values(state)]) {
    if (!Array.isArray(series)) continue
    for (const item of series as PaintingAction[]) {
      if (!item?.id || records.has(item.id)) continue
      const files = item.files || []
      const urls = item.urls || []
      const assets = Array.from({ length: Math.max(files.length, urls.length) }, (_, index) => ({
        name: files[index] ? FileManager.getStorageFileName(files[index]) : undefined,
        url: urls[index] || undefined
      })).filter(({ name, url }) => name || url)
      if (assets.length)
        records.set(item.id, {
          id: item.id,
          prompt: item.prompt || item.basePrompt || '',
          createdAt: files[0]?.created_at,
          assets
        })
    }
  }
  return [...records.values()]
}
