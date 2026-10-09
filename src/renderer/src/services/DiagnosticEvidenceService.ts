import { type DiagnosticEvidence, DiagnosticRecorder, type DiagnosticStage } from '@shared/diagnostics'

const recorder = new DiagnosticRecorder()
const operations = new Map<string, string>()
const PREFIX = 'zen-diagnostic-evidence:'
const INDEX = `${PREFIX}index`

// Diagnostic capture must never interrupt generation, including storage failures.
function persist(id: string) {
  try {
    const ids = ((window.keyv?.get(INDEX) ?? []) as string[]).filter((item) => item !== id)
    ids.push(id)
    for (const expired of ids.splice(0, Math.max(0, ids.length - 100))) window.keyv?.remove(`${PREFIX}${expired}`)
    window.keyv?.set(`${PREFIX}${id}`, recorder.get(id))
    window.keyv?.set(INDEX, ids)
  } catch {
    /* Best effort only; export reports missing evidence. */
  }
}

export function beginDiagnostic(id: string, metadata: Record<string, unknown>) {
  const previous = recorder.get(id)?.metadata.runtimeOperationId
  if (typeof previous === 'string') operations.delete(previous)
  const operationId = `zen-diag-${crypto.randomUUID()}`
  operations.set(operationId, id)
  while (operations.size > 100) operations.delete(operations.keys().next().value!)
  recorder.begin(id, { ...metadata, runtimeOperationId: operationId })
  persist(id)
  return operationId
}

export function recordDiagnostic(
  id: string | undefined,
  stage: DiagnosticStage,
  event: string,
  details?: Record<string, unknown>
) {
  try {
    if (id?.startsWith('zen-diag-') && !operations.has(id)) return
    const messageId = id ? (operations.get(id) ?? id) : undefined
    recorder.record(messageId, stage, event, details)
    if (messageId) persist(messageId)
  } catch {
    /* Never change request behavior. */
  }
}

export function getDiagnosticEvidence(id: string): DiagnosticEvidence | undefined {
  const live = recorder.get(id)
  if (live) return live
  try {
    return window.keyv?.get(`${PREFIX}${id}`) as DiagnosticEvidence | undefined
  } catch {
    return undefined
  }
}
