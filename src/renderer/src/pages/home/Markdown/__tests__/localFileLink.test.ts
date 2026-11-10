import { describe, expect, it } from 'vitest'

import { localFilePath } from '../localFileLink'

describe('local file links', () => {
  it('recognizes the three Windows report paths and encoded local paths', () => {
    for (const name of ['report.md', 'sources.json', 'source-matrix.json'])
      expect(localFilePath(`D:/working/ZenAI/${name}`)).toBe(`D:/working/ZenAI/${name}`)
    expect(localFilePath('file:///C:/My%20Reports/%E6%8A%A5%E5%91%8A.md')).toBe('C:/My Reports/报告.md')
    expect(localFilePath('C:\\Reports\\report.md')).toBe('C:/Reports/report.md')
    expect(localFilePath('/Users/me/report.md')).toBe('/Users/me/report.md')
  })
  it('rejects URL schemes, network shares, control characters and malformed encoding', () => {
    for (const value of [
      'https://example.org',
      'javascript:alert(1)',
      'data:text/html,hi',
      '//host/share',
      '\\\\host\\share',
      'file://host/share',
      'file:///C:/report.md?run=1',
      'C:/bad%00.md',
      'C:/bad%0a.md',
      'C:/bad%xx.md'
    ])
      expect(localFilePath(value)).toBeUndefined()
  })
})
