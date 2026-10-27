import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { syncBuiltinSkillFiles } from '../utils/builtinSkillFiles'

vi.unmock('node:os')
vi.unmock('node:path')

let root: string
let source: string
let destination: string
let backups: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-skill-files-'))
  source = path.join(root, 'bundled')
  destination = path.join(root, 'installed', 'writing')
  backups = path.join(root, 'backups')
  await fs.mkdir(path.join(source, 'scripts'), { recursive: true })
  await fs.writeFile(path.join(source, 'SKILL.md'), 'original skill')
  await fs.writeFile(path.join(source, 'scripts', 'check.py'), 'original script')
})
afterEach(async () => {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected test root')
  await fs.rm(root, { recursive: true, force: true })
})

describe('built-in skill content updates', () => {
  it('installs once and updates scripts within the same app version', async () => {
    expect(await syncBuiltinSkillFiles(source, destination, backups)).toBe(true)
    expect(await syncBuiltinSkillFiles(source, destination, backups)).toBe(false)
    await fs.writeFile(path.join(source, 'scripts', 'check.py'), 'fixed script')
    expect(await syncBuiltinSkillFiles(source, destination, backups)).toBe(true)
    expect(await fs.readFile(path.join(destination, 'scripts', 'check.py'), 'utf8')).toBe('fixed script')
    await expect(fs.access(backups)).rejects.toThrow()
  })

  it('backs up local changes before updating and retains unrelated user files', async () => {
    await syncBuiltinSkillFiles(source, destination, backups)
    await fs.writeFile(path.join(destination, 'SKILL.md'), 'user edited instructions')
    await fs.writeFile(path.join(destination, 'user-note.txt'), 'keep me')
    await fs.writeFile(path.join(source, 'SKILL.md'), 'new bundled instructions')
    await syncBuiltinSkillFiles(source, destination, backups)
    const [backup] = await fs.readdir(path.join(backups, 'writing'))
    expect(await fs.readFile(path.join(backups, 'writing', backup, 'SKILL.md'), 'utf8')).toBe(
      'user edited instructions'
    )
    expect(await fs.readFile(path.join(destination, 'user-note.txt'), 'utf8')).toBe('keep me')
    expect(await syncBuiltinSkillFiles(source, destination, backups)).toBe(false)
  })

  it('backs up a legacy installation and removes only retired tracked files', async () => {
    await fs.mkdir(destination, { recursive: true })
    await fs.writeFile(path.join(destination, 'SKILL.md'), 'legacy custom skill')
    await fs.writeFile(path.join(destination, '.version'), 'same version')
    await syncBuiltinSkillFiles(source, destination, backups)
    expect((await fs.readdir(path.join(backups, 'writing'))).length).toBe(1)
    await fs.writeFile(path.join(destination, 'extra.txt'), 'user content')
    await fs.rm(path.join(source, 'scripts', 'check.py'))
    await syncBuiltinSkillFiles(source, destination, backups)
    await expect(fs.access(path.join(destination, 'scripts', 'check.py'))).rejects.toThrow()
    expect(await fs.readFile(path.join(destination, 'extra.txt'), 'utf8')).toBe('user content')
  })

  it('repairs a missing installed file and ignores Python caches', async () => {
    await fs.mkdir(path.join(source, 'scripts', '__pycache__'))
    await fs.writeFile(path.join(source, 'scripts', '__pycache__', 'check.pyc'), 'cache')
    await syncBuiltinSkillFiles(source, destination, backups)
    await expect(fs.access(path.join(destination, 'scripts', '__pycache__'))).rejects.toThrow()
    await fs.rm(path.join(destination, 'scripts', 'check.py'))
    expect(await syncBuiltinSkillFiles(source, destination, backups)).toBe(true)
    expect(await fs.readFile(path.join(destination, 'scripts', 'check.py'), 'utf8')).toBe('original script')
  })

  it('ignores a corrupt manifest with paths outside the installed skill', async () => {
    await syncBuiltinSkillFiles(source, destination, backups)
    const outside = path.join(root, 'outside.txt')
    await fs.writeFile(outside, 'keep outside')
    await fs.writeFile(
      path.join(destination, '.builtin-content.json'),
      JSON.stringify({ version: 1, files: { '../../outside.txt': 'a'.repeat(64) } })
    )
    await fs.writeFile(path.join(source, 'SKILL.md'), 'new instructions')
    await syncBuiltinSkillFiles(source, destination, backups)
    expect(await fs.readFile(outside, 'utf8')).toBe('keep outside')
  })
})
