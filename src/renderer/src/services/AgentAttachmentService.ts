const joinAgentWorkspacePath = (workspace: string, ...parts: string[]): string => {
  const separator = workspace.includes('\\') || /^[A-Za-z]:/.test(workspace) ? '\\' : '/'
  return [workspace.replace(/[\\/]+$/, ''), ...parts.map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ''))].join(
    separator
  )
}

const isSafeMessageId = (messageId: string): boolean => /^[a-zA-Z0-9_-]{1,160}$/.test(messageId)

/** Returns the deterministic directory used for UI attachments of one message. */
export const getAgentAttachmentDirectory = (
  workspace: string,
  messageId: string,
  sessionId?: string
): string | undefined => {
  if (!workspace.trim() || !isSafeMessageId(messageId) || (sessionId !== undefined && !isSafeMessageId(sessionId))) {
    return undefined
  }
  return joinAgentWorkspacePath(workspace, '.zen-ai', 'ui-attachments', ...(sessionId ? [sessionId] : []), messageId)
}

/** Removes only the app-owned attachment directory for a message. */
export const cleanupAgentAttachmentDirectory = async (
  workspace: string,
  messageId: string,
  sessionId?: string
): Promise<void> => {
  const directory = getAgentAttachmentDirectory(workspace, messageId, sessionId)
  if (!directory) return
  if (!sessionId) return

  try {
    await window.api.file.deleteAgentAttachmentDir(workspace, sessionId, messageId)
  } catch {
    // Cleanup is best effort. A failed cleanup must never block deleting a
    // conversation or sending the next Agent request.
  }
}

/** Removes all UI attachment directories belonging to one Agent session. */
export const cleanupAgentSessionAttachmentDirectory = async (workspace: string, sessionId: string): Promise<void> => {
  if (!workspace.trim() || !isSafeMessageId(sessionId)) return
  try {
    await window.api.file.deleteAgentAttachmentDir(workspace, sessionId)
  } catch {
    // Best effort; never block remote session deletion.
  }
}
