import { describe, expect, it } from 'vitest'

import { formatMessageAnchorPreview } from './messageAnchorUtils'

describe('formatMessageAnchorPreview', () => {
  it('turns common Markdown into a compact plain-text preview', () => {
    expect(
      formatMessageAnchorPreview(
        '# Release plan\n\n- Review the [design](https://example.com)\n- Ship the `desktop` build'
      )
    ).toBe('Release plan Review the design Ship the desktop build')
  })

  it('keeps image alt text without exposing the image URL', () => {
    expect(formatMessageAnchorPreview('Please inspect ![dashboard](https://example.com/private.png)')).toBe(
      'Please inspect dashboard'
    )
  })

  it('limits long previews without returning an oversized tooltip', () => {
    expect(formatMessageAnchorPreview('1234567890', 6)).toBe('123...')
  })

  it('returns an empty preview for formatting-only content', () => {
    expect(formatMessageAnchorPreview('### ` `')).toBe('')
  })
})
