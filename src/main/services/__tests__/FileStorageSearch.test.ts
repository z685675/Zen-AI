import fs from 'node:fs/promises'
import path from 'node:path'

import type * as fileUtils from '@main/utils/file'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => importOriginal())
vi.mock('@main/utils/file', async (importOriginal) => {
  const actual = await importOriginal<typeof fileUtils>()
  const directory = () => path.join(process.cwd(), '.context', 'vitest-temp', 'file-storage-search-data')
  return { ...actual, getFilesDir: directory, getNotesDir: directory, getTempDir: directory }
})

import { fileStorage } from '../FileStorage'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

it('finds a Chinese filename using the standalone search program', async () => {
  const parent = path.join(process.cwd(), '.context', 'vitest-temp')
  await fs.mkdir(parent, { recursive: true })
  const directory = await fs.mkdtemp(path.join(parent, 'file-list-'))
  directories.push(directory)
  await fs.writeFile(path.join(directory, '中文项目.txt'), '预算 700', 'utf8')
  const files = await fileStorage.listDirectory({} as Electron.IpcMainInvokeEvent, directory, {
    searchPattern: '中文项目',
    recursive: true
  })
  expect(files.some((file) => file.includes('中文项目.txt'))).toBe(true)
})
