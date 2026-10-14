import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ list: vi.fn(), native: vi.fn(), folders: vi.fn(), read: vi.fn(), stat: vi.fn() }))
vi.mock('node:fs/promises', () => ({ default: { readdir: mocks.folders, readFile: mocks.read, lstat: mocks.stat } }))
vi.mock('@main/utils', () => ({ getDataPath: () => '/owned/Skills' }))
vi.mock('../../../skills/SkillRepository', () => ({ SkillRepository: { getInstance: () => ({ list: mocks.list }) } }))
vi.mock('../process', () => ({ inspectOpenCodeSkills: mocks.native }))

import { getSessionSkillInventory } from '../skillInventory'

beforeEach(() => {
  mocks.list.mockResolvedValue([
    { name: 'xlsx', folderName: 'xlsx', isEnabled: true },
    { name: 'disabled', folderName: 'disabled', isEnabled: false }
  ])
  mocks.folders.mockResolvedValue([{ name: 'docx', isDirectory: () => true, isSymbolicLink: () => false }])
  mocks.stat.mockResolvedValue({ isFile: () => true, size: 50 })
  mocks.read.mockResolvedValue('---\nname: docx\ndescription: test\n---\nprivate skill body')
  mocks.native.mockResolvedValue({ status: 'not-running', refreshRequired: false, skills: [] })
})
const session = { id: 's', accessible_paths: ['/workspace'] } as any
describe('on-demand inventory provenance', () => {
  it('keeps enabled and installed states distinct from unknown native discovery', async () => {
    const inventory = await getSessionSkillInventory(session)
    expect(inventory.nativeStatus).toBe('not-running')
    expect(inventory.skills.map((skill) => [skill.name, skill.installed, skill.enabled, skill.discovered])).toEqual([
      ['xlsx', true, true, null],
      ['disabled', true, false, null],
      ['docx', true, true, null]
    ])
    expect(JSON.stringify(inventory)).not.toContain('private skill body')
  })
  it('uses actual definition paths, not same-name guessing, and exposes stale enabled/discovered differences', async () => {
    mocks.native.mockResolvedValue({
      status: 'observed',
      refreshRequired: true,
      skills: [
        { name: 'xlsx', path: '/other/xlsx/SKILL.md' },
        { name: 'disabled', path: '/owned/Skills/disabled/SKILL.md' },
        { name: 'customize-opencode', path: '/native/customize/SKILL.md' }
      ]
    })
    const inventory = await getSessionSkillInventory(session)
    expect(inventory.refreshRequired).toBe(true)
    expect(inventory.skills.find((skill) => skill.name === 'xlsx' && skill.source === 'installed')?.discovered).toBe(
      false
    )
    expect(inventory.skills.find((skill) => skill.name === 'xlsx' && skill.source === 'native')?.discovered).toBe(true)
    expect(inventory.skills.find((skill) => skill.name === 'disabled')).toMatchObject({
      enabled: false,
      discovered: true
    })
    expect(inventory.skills.find((skill) => skill.name === 'customize-opencode')).toMatchObject({
      enabled: false,
      discovered: true,
      installed: false
    })
  })
  it('skips symlinks and oversized definitions without evaluating them', async () => {
    mocks.folders.mockResolvedValue([
      { name: 'link', isDirectory: () => true, isSymbolicLink: () => true },
      { name: 'large', isDirectory: () => true, isSymbolicLink: () => false }
    ])
    mocks.stat.mockResolvedValue({ isFile: () => true, size: 2_000_000 })
    mocks.read.mockClear()
    expect((await getSessionSkillInventory(session)).skills).toHaveLength(2)
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
