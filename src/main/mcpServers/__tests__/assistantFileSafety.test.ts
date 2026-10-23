import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.unmock('node:path')
import {
  assertSafeOutput,
  backupAssistantFile,
  prepareAssistantFileCopy,
  writeAssistantFile,
  writeAssistantOutput
} from '../assistantFileSafety'

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
  it('numbers conflicting deliverables, including concurrent writes, without asking or replacing', async () => {
    const file = path.join(root, 'report.xlsx')
    await fs.writeFile(file, 'original')
    const approve = vi.fn(async () => true)
    const outputs = await Promise.all(
      ['one', 'two', 'three'].map((data) => writeAssistantOutput(file, data, [root], { approve }))
    )
    expect(new Set(outputs.map((output) => output.path)).size).toBe(3)
    expect(outputs.every((output) => output.write_mode === 'new-file')).toBe(true)
    expect(await fs.readFile(file, 'utf8')).toBe('original')
    expect(await Promise.all(outputs.map((output) => fs.readFile(output.path, 'utf8')))).toEqual([
      'one',
      'two',
      'three'
    ])
    expect(approve).not.toHaveBeenCalled()
  })
  it('keeps explicit replacements on the confirmation and verified-backup route', async () => {
    const file = path.join(root, 'old.txt')
    await fs.writeFile(file, 'original')
    const denied = vi.fn(async () => false)
    await expect(writeAssistantOutput(file, 'changed', [root], { overwrite: true, approve: denied })).rejects.toThrow(
      'not approved'
    )
    expect(await fs.readdir(root)).toEqual(['old.txt'])
    const result = await writeAssistantOutput(file, 'changed', [root], { overwrite: true, approve: async () => true })
    expect(result.path).toBe(file)
    expect(await fs.readFile(result.backup_path, 'utf8')).toBe('original')
  })
  it('makes an independent working copy, including when the requested path is the original', async () => {
    const file = path.join(root, '预算.xlsx')
    const source = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])
    await fs.writeFile(file, source)
    const result = await prepareAssistantFileCopy(file, file, [root])
    expect(result).toMatchObject({ source_path: file, original_preserved: true })
    expect(result.working_path).toBe(path.join(root, '预算 (1).xlsx'))
    expect(await fs.readFile(result.working_path)).toEqual(source)
    await fs.writeFile(result.working_path, 'modified')
    expect(await fs.readFile(file)).toEqual(source)
  })
  it('rejects missing, unauthorized, folder, oversized and extension-changing working copies', async () => {
    const file = path.join(root, 'source.txt')
    await fs.writeFile(file, 'original')
    await expect(prepareAssistantFileCopy(file, path.join(root, 'out.pdf'), [root])).rejects.toThrow('extension')
    await expect(prepareAssistantFileCopy(file, path.join(root, '..', 'out.txt'), [root])).rejects.toThrow('outside')
    await expect(prepareAssistantFileCopy(path.join(root, 'absent.txt'), file, [root])).rejects.toThrow('missing')
    await expect(prepareAssistantFileCopy(root, file, [root])).rejects.toThrow('regular file')
    const handle = await fs.open(file, 'r+')
    await handle.truncate(128 * 1024 * 1024 + 1)
    await handle.close()
    await expect(prepareAssistantFileCopy(file, path.join(root, 'large.txt'), [root])).rejects.toThrow('128 MiB')
    expect(await fs.readdir(root)).toEqual(['source.txt'])
  })
  it('does not publish a corrupt copy or permit replacement after backup verification fails', async () => {
    const file = path.join(root, 'source.txt')
    await fs.writeFile(file, 'original')
    const copy = vi.spyOn(fs, 'copyFile').mockImplementation(async (_source, target) => {
      await fs.writeFile(target, 'corrupt')
    })
    await expect(prepareAssistantFileCopy(file, path.join(root, 'copy.txt'), [root])).rejects.toThrow('verification')
    await expect(
      writeAssistantOutput(file, 'changed', [root], { overwrite: true, approve: async () => true })
    ).rejects.toThrow('verification')
    expect(copy).toHaveBeenCalledTimes(2)
    expect(await fs.readFile(file, 'utf8')).toBe('original')
    expect(await fs.readdir(path.join(root, '.zen-backups'))).toEqual([])
    expect((await fs.readdir(root)).filter((name) => name.startsWith('.zen-write'))).toEqual([])
  })
  it('cleans temporary copies if cancelled after copying and keeps the original', async () => {
    const file = path.join(root, 'source.txt')
    await fs.writeFile(file, 'original')
    const abort = new AbortController()
    const actualCopy = fs.copyFile.bind(fs)
    vi.spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
      await actualCopy(...args)
      abort.abort(new Error('stopped'))
    })
    await expect(prepareAssistantFileCopy(file, path.join(root, 'copy.txt'), [root], abort.signal)).rejects.toThrow(
      'stopped'
    )
    expect(await fs.readdir(root)).toEqual(['source.txt'])
    expect(await fs.readFile(file, 'utf8')).toBe('original')
  })
  it('refuses symlinked parents escaping the authorized directory for working copies', async () => {
    const file = path.join(root, 'source.txt')
    await fs.writeFile(file, 'original')
    await fs.symlink(path.dirname(root), path.join(root, 'outside'), 'junction')
    await expect(prepareAssistantFileCopy(file, path.join(root, 'outside', 'copy.txt'), [root])).rejects.toThrow(
      'outside'
    )
  })
  it('rejects source changes during a copy without publishing a stale working file', async () => {
    const file = path.join(root, 'source.txt')
    await fs.writeFile(file, 'original')
    const copy = fs.copyFile.bind(fs)
    vi.spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
      await copy(...args)
      await fs.writeFile(file, 'user changed this')
    })
    await expect(prepareAssistantFileCopy(file, path.join(root, 'copy.txt'), [root])).rejects.toThrow('changed')
    expect(await fs.readdir(root)).toEqual(['source.txt'])
    expect(await fs.readFile(file, 'utf8')).toBe('user changed this')
  })
})
