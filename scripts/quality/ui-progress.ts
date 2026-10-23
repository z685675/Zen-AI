export type UIWaitPhase = 'permission' | 'tool' | 'model'

export interface UIWaitProgress {
  phase: UIWaitPhase
}

/** Scope to this turn's tool IDs: a stale permission from another session must not win. */
export function inferUIWaitPhase(
  tools: Array<{ toolCallId?: string; status?: string }>,
  permissions: Array<{ toolCallId?: string; status?: string }>
): UIWaitPhase {
  const calls = new Set(tools.map((tool) => tool.toolCallId).filter(Boolean))
  if (
    permissions.some(
      (request) =>
        calls.has(request.toolCallId) &&
        ['pending', 'submitting-allow', 'submitting-deny'].includes(request.status ?? '')
    )
  )
    return 'permission'
  if (tools.some((tool) => ['pending', 'streaming', 'invoking'].includes(tool.status ?? ''))) return 'tool'
  return 'model'
}
