import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/services/FileManager', () => ({ default: { getFilePath: () => '/storage/original.pdf' } }))
import { getMessageAttachmentPath } from '../messageAttachmentPath'

describe('snapshot upload paths', () => {
  it('uses the independent copy only when explicitly marked', () => {
    const block = { file: { path: '/workspace/.zen-ai/continuations/copy/upload.pdf' } } as any
    expect(getMessageAttachmentPath(block)).toBe('/storage/original.pdf')
    block.metadata = { legacyContinuation: { copied_attachment: true } }
    expect(getMessageAttachmentPath(block)).toBe(block.file.path)
  })
  it('handles a missing upload', () => {
    expect(getMessageAttachmentPath({} as any)).toBe('')
  })
})
