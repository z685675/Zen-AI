import { describe, expect, it } from 'vitest'

import { createAttachmentReference, getCompletedAssistantResponseSourceIds } from '../ContextAttachmentPolicy'

describe('ContextAttachmentPolicy', () => {
  it('uses completed assistant replies as the marker for dialogue-first attachment memory', () => {
    const answeredIds = getCompletedAssistantResponseSourceIds([
      { role: 'assistant', status: 'processing', askId: 'unfinished-upload' },
      { role: 'assistant', status: 'success', askId: 'answered-upload' },
      { role: 'assistant', status: 'error', askId: 'failed-upload' },
      { role: 'assistant', status: 'success' }
    ])

    expect(answeredIds).toEqual(new Set(['answered-upload']))
  })

  it('keeps a lightweight local source reference instead of claiming every detail was remembered', () => {
    const reference = createAttachmentReference('sales.xlsx', 'file')

    expect(reference).toContain('sales.xlsx')
    expect(reference).toContain('用户后续纠正')
    expect(reference).toContain('仍保留在本地')
  })
})
