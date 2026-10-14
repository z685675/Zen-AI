import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.unmock('node:path')
import { assertSafeOutput, backupAssistantFile, writeAssistantFile } from '../assistantFileSafety'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-safe-write-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

describe('new assistant controlled writes', () => {
  it('publishes a new complete file without creating a backup', async () => {
    const file = path.join(root, 'new.txt')
    expect(await writeAssistantFile(file, 'complete', [root])).toEqual({
      backup_path: undefined,
      write_mode: 'new-file'
    })
    expect(await fs.readFile(file, 'utf8')).toBe('complete')
    expect(await fs.readdir(root)).toEqual(['new.txt'])
  })
  it('defaults to no overwrite, with no permission request or side effects', async () => {
    const file = path.join(root, 'old.txt')
    await fs.writeFile(file, 'original')
    const approve = vi.fn(async () => true)
    await expect(writeAssistantFile(file, 'new', [root], { approve })).rejects.toThrow('already exists')
    expect(approve).not.toHaveBeenCalled()
    expect(await fs.readFile(file, 'utf8')).toBe('original')
    expect(await fs.readdir(root)).toEqual(['old.txt'])
  })
  it('keeps original untouched if overwrite is rejected or approval is missing', async () => {
    const file = path.join(root, 'old.txt')
    await fs.writeFile(file, 'original')
    for (const approve of [undefined, async () => false]) {
      await expect(writeAssistantFile(file, 'new', [root], { overwrite: true, approve })).rejects.toThrow(
        'not approved'
      )
    }
    expect(await fs.readFile(file, 'utf8')).toBe('original')
    expect(await fs.readdir(root)).toEqual(['old.txt'])
  })
  it('retains a unique backup and atomically replaces an approved target', async () => {
    const file = path.join(root, 'old.txt')
    await fs.writeFile(file, 'original')
    const result = await writeAssistantFile(file, 'new', [root], { overwrite: true, approve: async () => true })
    expect(result.write_mode).toBe('replaced-with-backup')
    expect(await fs.readFile(result.backup_path!, 'utf8')).toBe('original')
    expect(await fs.readFile(file, 'utf8')).toBe('new')
    const second = await backupAssistantFile(file, [root])
    expect(second.backup_path).not.toBe(result.backup_path)
    expect(await fs.readFile(second.backup_path, 'utf8')).toBe('new')
  })
  it('refuses changed files while waiting for approval', async () => {
    const file = path.join(root, 'old.txt')
    await fs.writeFile(file, 'original')
    await expect(
      writeAssistantFile(file, 'model output', [root], {
        overwrite: true,
        approve: async () => {
          await fs.writeFile(file, 'user changed this')
          return true
        }
      })
    ).rejects.toThrow('changed while awaiting')
    expect(await fs.readFile(file, 'utf8')).toBe('user changed this')
  })
  it('cancellation cannot replace an original', async () => {
    const file = path.join(root, 'old.txt')
    await fs.writeFile(file, 'original')
    const abort = new AbortController()
    await expect(
      writeAssistantFile(file, 'new', [root], {
        overwrite: true,
        signal: abort.signal,
        approve: async () => {
          abort.abort(new Error('stopped'))
          return true
        }
      })
    ).rejects.toThrow('stopped')
    expect(await fs.readFile(file, 'utf8')).toBe('original')
  })
  it('serializes two new writes so only one succeeds', async () => {
    const file = path.join(root, 'new.txt')
    const results = await Promise.allSettled([
      writeAssistantFile(file, 'one', [root]),
      writeAssistantFile(file, 'two', [root])
    ])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(await fs.readFile(file, 'utf8')).toBe('one')
  })
  it('an already stopped task creates no directories or staging files', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(
      writeAssistantFile(path.join(root, 'nested', 'file.txt'), 'new', [root], { signal: controller.signal })
    ).rejects.toThrow('stopped')
    expect(await fs.readdir(root)).toEqual([])
  })
  it('rejects directory, outside and symlink outputs', async () => {
    await expect(writeAssistantFile(root, 'bad', [root])).rejects.toThrow('regular file')
    await expect(assertSafeOutput(path.join(root, '..', 'outside.txt'), [root])).rejects.toThrow('outside')
    const nested = path.join(root, 'nested')
    await fs.mkdir(nested)
    const link = path.join(root, 'link')
    await fs.symlink(nested, link, 'junction')
    await expect(writeAssistantFile(link, 'bad', [root])).rejects.toThrow('symbolic link')
  })
  it('does not leave a partial result on failed publication', async () => {
    const file = path.join(root, 'new.txt')
    vi.spyOn(fs, 'link').mockRejectedValueOnce(new Error('disk error'))
    await expect(writeAssistantFile(file, 'output', [root])).rejects.toThrow('disk error')
    expect(await fs.readdir(root)).toEqual([])
  })
})
