export type PersistedAgentSessionRow = {
  agent_session_id: string | null
  content: unknown
}

function parsePersistedContent(content: unknown): { message?: Record<string, unknown> } | undefined {
  let parsedContent = content
  if (typeof parsedContent === 'string') {
    try {
      parsedContent = JSON.parse(parsedContent)
    } catch {
      return undefined
    }
  }

  return parsedContent && typeof parsedContent === 'object'
    ? (parsedContent as { message?: Record<string, unknown> })
    : undefined
}

export function getPersistedMessageModelId(content: unknown): string | undefined {
  const message = parsePersistedContent(content)?.message
  if (!message) {
    return undefined
  }

  const modelId = message.modelId
  if (typeof modelId === 'string' && modelId.includes(':')) {
    return modelId
  }

  const model = message.model
  if (model && typeof model === 'object') {
    const provider = (model as { provider?: unknown }).provider
    const id = (model as { id?: unknown }).id
    if (typeof provider === 'string' && provider && typeof id === 'string' && id) {
      return `${provider}:${id}`
    }
  }

  return typeof modelId === 'string' ? modelId : undefined
}

export function findCompatibleAgentSessionId(rows: PersistedAgentSessionRow[], modelId?: string): string {
  if (!modelId) {
    return ''
  }

  const matchingMessage = rows.find((row) => {
    const message = parsePersistedContent(row.content)?.message
    return message?.status === 'success' && getPersistedMessageModelId(row.content) === modelId
  })

  return matchingMessage?.agent_session_id || ''
}
