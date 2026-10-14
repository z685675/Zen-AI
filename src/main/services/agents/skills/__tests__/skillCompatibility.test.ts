import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs/promises')
vi.unmock('node:path')
vi.unmock('node:os')
import { inspectSkillCompatibility, readSkillDeclaration } from '../skillCompatibility'

let root: string
const installed = { id: 'one', name: 'Example', folderName: 'one', source: 'zip', isEnabled: true } as any
async function definition(folder: string, text: string) {
  await fs.mkdir(path.join(root, folder), { recursive: true })
  await fs.writeFile(path.join(root, folder, 'SKILL.md'), text)
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-skill-review-'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await fs.rm(root, { recursive: true, force: true })
})

describe('read-only skill compatibility evidence', () => {
  it('reads declared requirements, never leaks environment values or executes scripts', async () => {
    vi.stubEnv('ZEN_TEST_PRESENT', 'secret value')
    await definition(
      'one',
      '---\nname: Example\ndescription: example\ncompatibility: requires external MCP\nallowed-tools: [browser, custom]\nmetadata:\n  requires:\n    bins: [zen_command_definitely_absent]\n    anyBins: [zen_command_also_absent]\n    env: [ZEN_TEST_PRESENT, ZEN_TEST_UNSET]\n---\nInstructions'
    )
    const report = await inspectSkillCompatibility(installed, [installed], root, path.join(root, 'builtin'))
    expect(report).toMatchObject({
      definitionValid: true,
      enabled: true,
      compatibility: 'requires external MCP',
      declaredTools: ['browser', 'custom'],
      missingCommands: ['zen_command_definitely_absent'],
      alternativesAvailable: false,
      missingEnvironment: ['ZEN_TEST_UNSET']
    })
    expect(JSON.stringify(report)).not.toContain('secret value')
    expect(await fs.readdir(root)).toEqual(['one'])
  })
  it('reports enabled and builtin same-name candidates without claiming a runtime winner', async () => {
    await definition('one', '---\nname: Example\n---\nOne')
    await definition('two', '---\nname: Example\n---\nTwo')
    await definition('builtin/default', '---\nname: Example\n---\nBuiltin')
    const report = await inspectSkillCompatibility(
      installed,
      [installed, { ...installed, id: 'two', folderName: 'two', source: 'local' }],
      root,
      path.join(root, 'builtin')
    )
    expect(report.conflicts).toEqual([
      { name: 'Example', source: 'local', folder: 'two' },
      { name: 'Example', source: 'builtin', folder: 'default' }
    ])
    expect(report).not.toHaveProperty('winner')
  })
  it('handles invalid/absent definition as a report, not a runtime-blocking exception', async () => {
    expect(await inspectSkillCompatibility(installed, [], root, root)).toMatchObject({
      definitionValid: false,
      warnings: ['definition-unreadable-or-invalid']
    })
    await definition('one', '---\nname: [invalid]\n---\nbody')
    await expect(readSkillDeclaration(path.join(root, 'one'))).rejects.toThrow('name')
  })
  it('does not infer undeclared dependencies or enable a disabled skill', async () => {
    await definition('one', '---\nname: Example\n---\nRun third party script')
    expect(
      await inspectSkillCompatibility({ ...installed, isEnabled: false }, [], root, path.join(root, 'builtin'))
    ).toMatchObject({
      enabled: false,
      definitionValid: true,
      requiredCommands: [],
      requiredEnvironment: [],
      compatibility: null
    })
  })
})
