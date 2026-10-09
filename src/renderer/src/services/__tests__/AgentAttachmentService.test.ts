import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_ATTACHMENT_FALLBACK_MAX_CHARS,
  buildAgentStructuredAttachmentFallback,
  cleanupAgentAttachmentDirectory,
  cleanupAgentSessionAttachmentDirectory,
  getAgentAttachmentDirectory
} from '../AgentAttachmentService'

describe('AgentAttachmentService', () => {
  it('does not pre-parse attachments when every file was copied to the SDK workspace', async () => {
    const read = vi.fn()
    expect(await buildAgentStructuredAttachmentFallback([], read)).toBe('')
    expect(read).not.toHaveBeenCalled()
  })

  it('bounds the total inline fallback and explicitly labels omitted content', async () => {
    const files = [
      { id: '1', type: 'document', origin_name: 'report.xlsx', ext: '.xlsx' },
      { id: '2', type: 'document', origin_name: 'another.xlsx', ext: '.xlsx' }
    ] as Parameters<typeof buildAgentStructuredAttachmentFallback>[0]
    const read = vi.fn().mockResolvedValue('x'.repeat(100_000))
    const text = await buildAgentStructuredAttachmentFallback(files, read)
    expect(text.length).toBeLessThanOrEqual(AGENT_ATTACHMENT_FALLBACK_MAX_CHARS)
    expect(text).toContain('仅提供部分文字预览')
    expect(text).toContain('其余附件未自动提取')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('reports failed extraction without pretending the original is in the workspace', async () => {
    const files = [{ id: '1', type: 'document', origin_name: 'report.xlsx', ext: '.xlsx' }] as Parameters<
      typeof buildAgentStructuredAttachmentFallback
    >[0]
    const text = await buildAgentStructuredAttachmentFallback(
      files,
      vi.fn().mockRejectedValue(new Error('parse failed'))
    )
    expect(text).toContain('原文件未能保存到工作区')
    expect(text).toContain('重新上传')
  })

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
