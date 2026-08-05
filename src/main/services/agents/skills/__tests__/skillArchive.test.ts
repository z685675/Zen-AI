import { describe, expect, it } from 'vitest'

import { assertSafeSkillArchiveEntry } from '../skillArchive'

describe('Skill archive entry safety', () => {
  it('accepts normal relative entries', () => {
    expect(() => assertSafeSkillArchiveEntry('research/SKILL.md')).not.toThrow()
    expect(() => assertSafeSkillArchiveEntry('scripts\\validate.py')).not.toThrow()
  })

  it.each(['../outside.txt', 'nested/../../outside.txt', '/absolute.txt', 'C:/absolute.txt'])(
    'rejects unsafe entry %s',
    (entryName) => {
      expect(() => assertSafeSkillArchiveEntry(entryName)).toThrow('Unsafe ZIP entry path')
    }
  )
})
