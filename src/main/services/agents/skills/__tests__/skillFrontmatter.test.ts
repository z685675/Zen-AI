import { describe, expect, it } from 'vitest'

import { readSkillFrontmatter } from '../skillFrontmatter'

describe('data-only skill metadata inspection', () => {
  it.each(['', 'yaml', 'yml', 'json'])('reads %s data without executing instructions', (language) => {
    const header = language === 'json' ? '{"name":"xlsx"}' : 'name: xlsx'
    expect(readSkillFrontmatter(`---${language}\r\n${header}\r\n---\r\nRun instructions later`)).toEqual({
      data: { name: 'xlsx' },
      content: 'Run instructions later'
    })
  })
  it('rejects executable engines without evaluating their body', () => {
    const name = 'zenSkillInspectionMustNotExecute'
    expect(() =>
      readSkillFrontmatter(`---javascript\n(globalThis.${name} = true, {name: 'unsafe'})\n---\nbody`)
    ).toThrow('YAML or JSON')
    expect((globalThis as Record<string, unknown>)[name]).toBeUndefined()
  })
  it('rejects custom YAML object tags', () => {
    expect(() => readSkillFrontmatter('---\nname: !!js/function function() { return 1 }\n---\nbody')).toThrow(
      'Unsupported'
    )
  })
})
