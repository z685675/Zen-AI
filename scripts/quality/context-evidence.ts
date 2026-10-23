import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import type { Page } from '@playwright/test'

export async function contextEvidence(page: Page, instance: string, entry: string) {
  const checkpoints = await page.evaluate(() => {
    const ids = new Set(
      Object.values((window as any).store.getState().messages.entities)
        .map((item: any) => item?.topicId)
        .filter(Boolean)
    )
    return [...ids]
      .map((id) => (window as any).keyv?.get(`unified-context-checkpoint:${id}`))
      .filter(Boolean)
      .map((value: any) => ({
        boundary: value.includedThroughMessageId,
        sourceTokens: value.sourceTokens,
        hasSummary: typeof value.summary === 'string' && value.summary.trim().length > 0,
        updatedAt: value.updatedAt
      }))
  })
  const directory = path.join(instance, 'userData/logs/diagnostics')
  const native: Array<{ operation: string; event: string; at: unknown }> = []
  let unavailable: string | undefined
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('symbolic diagnostic directory')
    const names = (await readdir(directory)).filter((name) => /^diag-[\w.-]+\.json$/.test(name))
    if (names.length > 100) throw new Error('too many diagnostic snapshots')
    for (const name of names) {
      const file = path.join(directory, name)
      const info = await lstat(file)
      if (info.isSymbolicLink() || info.size > 4 * 1024 * 1024) continue
      const snapshot = JSON.parse(await readFile(file, 'utf8'))
      for (const event of snapshot.events ?? [])
        if (event.event === 'native-compacted')
          native.push({ operation: snapshot.operationId, event: event.event, at: event.at })
    }
  } catch {
    unavailable = 'diagnostic snapshots unavailable; no compaction assumed'
  }
  return {
    entry,
    checkpoints,
    native,
    unavailable,
    compactionObserved:
      entry === 'chat' ? checkpoints.some((value: any) => value.boundary && value.hasSummary) : native.length > 0
  }
}
