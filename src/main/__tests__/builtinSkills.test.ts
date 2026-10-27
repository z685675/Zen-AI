import fs from 'node:fs/promises'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { syncBuiltinSkillFiles } from '../utils/builtinSkillFiles'
import { installBuiltinSkills } from '../utils/builtinSkills'

vi.mock('node:fs/promises', () => ({
  default: {
    access: vi.fn(),
    readdir: vi.fn(),
    mkdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readlink: vi.fn(),
    symlink: vi.fn(),
    rm: vi.fn()
  }
}))
vi.mock('../utils/builtinSkillFiles', () => ({ syncBuiltinSkillFiles: vi.fn() }))
vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/app',
    getPath: () => '/userData',
    getVersion: () => '2.0.0'
  }
}))
vi.mock('../utils', () => ({
  getDataPath: (subPath: string) => path.join('/userData/Data', subPath),
  toAsarUnpackedPath: (value: string) => value
}))
const mockRepo = { getByFolderName: vi.fn(), delete: vi.fn(), insert: vi.fn() }
vi.mock('../services/agents/skills/SkillRepository', () => ({ SkillRepository: { getInstance: () => mockRepo } }))
vi.mock('../utils/markdownParser', () => ({
  parseSkillMetadata: async () => ({ name: 'Test', description: 'A test' })
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fs.access).mockResolvedValue(undefined)
  vi.mocked(fs.readdir).mockResolvedValue([{ name: 'writing', isDirectory: () => true }] as any)
  vi.mocked(fs.readFile).mockResolvedValue('skill body')
  vi.mocked(fs.readlink).mockResolvedValue(path.join('/userData/Data/Skills/writing'))
  vi.mocked(syncBuiltinSkillFiles).mockResolvedValue(true)
  mockRepo.getByFolderName.mockResolvedValue(null)
})

describe('installBuiltinSkills', () => {
  it('returns when bundled resources do not exist', async () => {
    vi.mocked(fs.access).mockRejectedValueOnce(new Error('ENOENT'))
    await installBuiltinSkills()
    expect(syncBuiltinSkillFiles).not.toHaveBeenCalled()
  })
  it('uses content-based updates and registers a built-in skill', async () => {
    await installBuiltinSkills()
    expect(syncBuiltinSkillFiles).toHaveBeenCalledWith(
      path.join('/app/resources/skills/writing'),
      path.join('/userData/Data/Skills/writing'),
      path.join('/userData/Data/SkillBackups')
    )
    expect(mockRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ folder_name: 'writing', source: 'builtin' }))
    expect(fs.writeFile).toHaveBeenCalledWith(path.join('/userData/Data/Skills/writing/.version'), '2.0.0', 'utf-8')
  })
  it('skips unchanged metadata and preserves disabled built-ins on content updates', async () => {
    mockRepo.getByFolderName.mockResolvedValue({ id: 'existing', isEnabled: false, createdAt: 1000 })
    vi.mocked(syncBuiltinSkillFiles).mockResolvedValueOnce(false)
    await installBuiltinSkills()
    expect(mockRepo.insert).not.toHaveBeenCalled()
    await installBuiltinSkills()
    expect(mockRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ is_enabled: false, created_at: 1000 }))
  })
  it('recovers missing metadata without copying unchanged files', async () => {
    vi.mocked(syncBuiltinSkillFiles).mockResolvedValue(false)
    await installBuiltinSkills()
    expect(mockRepo.insert).toHaveBeenCalledOnce()
  })
  it('ignores non-directories and names escaping the skills root', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([
      { name: '..', isDirectory: () => true },
      { name: '../outside', isDirectory: () => true },
      { name: 'README.md', isDirectory: () => false }
    ] as any)
    await installBuiltinSkills()
    expect(syncBuiltinSkillFiles).not.toHaveBeenCalled()
  })
})
