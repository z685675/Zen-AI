import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cleanupAgentAttachmentDirectory,
  cleanupAgentSessionAttachmentDirectory,
  getAgentAttachmentDirectory
} from '../AgentAttachmentService'

describe('AgentAttachmentService', () => {
  beforeEach(() => {
    Object.assign(window.api.file, {
      deleteAgentAttachmentDir: vi.fn().mockResolvedValue(undefined)
    })
  })

  it('keeps message attachments inside the session-scoped app directory', () => {
    expect(getAgentAttachmentDirectory('C:\\workspace', 'message-1', 'session-1')).toBe(
      'C:\\workspace\\.zen-ai\\ui-attachments\\session-1\\message-1'
    )
  })

  it('rejects unsafe identifiers before touching the filesystem', async () => {
    await cleanupAgentAttachmentDirectory('C:\\workspace', '..\\outside', 'session-1')
    expect(window.api.file.deleteAgentAttachmentDir).not.toHaveBeenCalled()
  })

  it('cleans an entire session attachment directory separately from remote deletion', async () => {
    await cleanupAgentSessionAttachmentDirectory('C:\\workspace', 'session-1')
    expect(window.api.file.deleteAgentAttachmentDir).toHaveBeenCalledWith('C:\\workspace', 'session-1')
  })
})
