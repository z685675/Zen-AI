import * as fs from 'node:fs'

import { shell } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fileStorage } from '../FileStorage'

const event = {} as Electron.IpcMainInvokeEvent
const file = '/output/report.pdf'
const stat = (directory = false) => ({ isFile: () => !directory, isDirectory: () => directory }) as fs.Stats

beforeEach(() => {
  vi.mocked(fs.promises.stat).mockReset()
  Object.assign(shell, { openPath: vi.fn().mockResolvedValue('') })
})

describe('deliverable path checks and guarded opening', () => {
  it('checks files and directories without reading content and deduplicates requested paths', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValueOnce(stat()).mockResolvedValueOnce(stat(true))
    expect(await fileStorage.checkPaths(event, [file, '/output/project', file])).toEqual([
      { path: file, status: 'available' },
      { path: '/output/project', status: 'available' }
    ])
    expect(fs.promises.stat).toHaveBeenCalledTimes(2)
    expect(fs.promises.readFile).not.toHaveBeenCalled()
  })

  it('distinguishes missing paths from inaccessible paths', async () => {
    vi.mocked(fs.promises.stat)
      .mockRejectedValueOnce(Object.assign(new Error(), { code: 'ENOENT' }))
      .mockRejectedValueOnce(Object.assign(new Error(), { code: 'ENOTDIR' }))
      .mockRejectedValueOnce(Object.assign(new Error(), { code: 'EACCES' }))
    expect(await fileStorage.checkPaths(event, [file, '/gone/child', '/denied'])).toEqual([
      { path: file, status: 'missing' },
      { path: '/gone/child', status: 'missing' },
      { path: '/denied', status: 'unavailable' }
    ])
  })

  it.each([{ paths: ['relative.pdf'] }, { paths: ['/bad\0file'] }, { paths: Array(201).fill(file) }, { paths: null }])(
    'rejects malformed or unbounded IPC inputs: $paths',
    async ({ paths }) => {
      await expect(fileStorage.checkPaths(event, paths as string[])).rejects.toThrow('absolute file paths')
      expect(fs.promises.stat).not.toHaveBeenCalled()
    }
  )

  it('never invokes the OS shell for a missing file', async () => {
    vi.mocked(fs.promises.stat).mockRejectedValue(Object.assign(new Error(), { code: 'ENOENT' }))
    await expect(fileStorage.openPath(event, file)).rejects.toThrow('missing')
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('opens an existing file and still propagates OS application failures', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue(stat())
    await fileStorage.openPath(event, file)
    expect(shell.openPath).toHaveBeenCalledWith(file)
    vi.mocked(shell.openPath).mockResolvedValueOnce('No associated application')
    await expect(fileStorage.openPath(event, file)).rejects.toThrow('No associated application')
  })
})
