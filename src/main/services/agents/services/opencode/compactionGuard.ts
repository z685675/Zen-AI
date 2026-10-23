import type { OpenCodeClient } from './client'

export type CompactionEntry = {
  info: { id: string; role: string; parentID?: string; summary?: boolean; finish?: string; error?: unknown }
  parts: Array<{ id: string; type: string; text?: string }>
}

/** Do not replace native compaction. Reject only a demonstrably empty finished
 * checkpoint, which upstream otherwise accepts as a history cutoff. Ordinary
 * messages, files, nonempty summaries and failed/in-flight summaries stay intact. */
export async function discardEmptyNativeCompaction(
  client: Pick<OpenCodeClient, 'request'>,
  sessionId: string,
  entries: CompactionEntry[],
  signal: AbortSignal,
  running = false
): Promise<boolean> {
  // A later failed/in-flight summary does not supersede an earlier accepted
  // cutoff in OpenCode. Validate the latest accepted boundary, not just the
  // latest record carrying summary=true.
  const invalid: Array<{ summary: CompactionEntry; marker: CompactionEntry; boundaries: CompactionEntry['parts'] }> = []
  for (const summary of entries.toReversed()) {
    if (summary.info.role !== 'assistant' || !summary.info.summary || !summary.info.finish || summary.info.error)
      continue
    if (summary.parts.some((part) => part.type === 'text' && part.text?.trim())) break
    if (!summary.info.parentID) throw new Error('Empty native summary has no history boundary; no history was changed')
    const marker = entries.find((entry) => entry.info.id === summary.info.parentID && entry.info.role === 'user')
    const boundaries = marker?.parts.filter((part) => part.type === 'compaction')
    if (!marker || !boundaries?.length)
      throw new Error('Empty native summary has no compaction marker; no history was changed')
    invalid.push({ summary, marker, boundaries })
  }
  if (!invalid.length) return false
  const base = `/session/${encodeURIComponent(sessionId)}`
  if (running) await client.request(`${base}/abort`, 'POST', undefined, signal)
  // Remove the invalid cutoff FIRST. Even if marker cleanup fails, original
  // ordinary history is no longer hidden from filterCompacted on the next run.
  for (const { summary, marker, boundaries } of invalid) {
    await client.request(`${base}/message/${encodeURIComponent(summary.info.id)}`, 'DELETE', undefined, signal)
    for (const part of boundaries) {
      await client.request(
        `${base}/message/${encodeURIComponent(marker.info.id)}/part/${encodeURIComponent(part.id)}`,
        'DELETE',
        undefined,
        signal
      )
    }
  }
  return true
}
