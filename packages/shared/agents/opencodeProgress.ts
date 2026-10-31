/** Internal work is progress, but must never become answer text or a successful turn. */
export type OpenCodeInternalProgress = {
  type: 'opencode_internal_progress'
  stage: 'compacting'
  kind: 'text' | 'reasoning' | 'completed'
  characters: number
}

export function isOpenCodeInternalProgress(value: unknown): value is OpenCodeInternalProgress {
  if (!value || typeof value !== 'object') return false
  const progress = value as OpenCodeInternalProgress
  return (
    progress.type === 'opencode_internal_progress' &&
    progress.stage === 'compacting' &&
    Number.isSafeInteger(progress.characters) &&
    (progress.kind === 'completed'
      ? progress.characters === 0
      : (progress.kind === 'text' || progress.kind === 'reasoning') && progress.characters > 0)
  )
}
