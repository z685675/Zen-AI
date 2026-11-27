import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import { listenOnLoopback } from '@shared/utils/loopbackServer'
import archiver from 'archiver'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { extractBackupArchive } from '../BackupArchive'
import WebDav from '../WebDav'

vi.unmock('node:fs')
vi.unmock('node:path')

const testRoot = path.resolve('.context', 'vitest-temp')
const directories: string[] = []

async function createBackup() {
  await mkdir(testRoot, { recursive: true })
  const directory = await mkdtemp(path.join(testRoot, 'backup-archive-'))
  directories.push(directory)
  const source = path.join(directory, 'fixture.zip')
  const destination = path.join(directory, 'restore')
  await mkdir(destination)
  const zip = archiver('zip')
  const writing = pipeline(zip, createWriteStream(source))
  zip.append('metadata', { name: 'metadata.json' })
  zip.append('example attachment', { name: 'Data/Files/example.txt' })
  await Promise.all([writing, zip.finalize()])
  return { source, destination }
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== testRoot || !path.basename(directory).startsWith('backup-archive-'))
      throw new Error('Unexpected backup test directory')
    await rm(directory, { recursive: true, force: true })
  }
})

describe('backup ZIP staging', () => {
  it('verifies and extracts an application-generated ZIP', async () => {
    const { source, destination } = await createBackup()
    await extractBackupArchive(source, destination)
    expect(await readFile(path.join(destination, 'metadata.json'), 'utf8')).toBe('metadata')
    expect(await readFile(path.join(destination, 'Data/Files/example.txt'), 'utf8')).toBe('example attachment')
  })

  it('streams a normal WebDAV download through the same archive validator', async () => {
    const { source, destination } = await createBackup()
    const archive = await readFile(source)
    const received = vi.fn()
    const server = createServer((request, response) => {
      received(request.url)
      response.write(archive.subarray(0, 24))
      response.end(archive.subarray(24))
    })
    const port = await listenOnLoopback(server)
    const client = new WebDav({ webdavHost: 'http://127.0.0.1:' + port, webdavPath: '/backups' })
    const download = path.join(path.dirname(source), 'download.zip')
    const controller = new AbortController()
    try {
      await pipeline(client.openReadStream('archive copy.zip', controller.signal), createWriteStream(download))
      await extractBackupArchive(download, destination)
      expect(received).toHaveBeenCalledExactlyOnceWith('/backups/archive%20copy.zip')
      expect(await readFile(path.join(destination, 'metadata.json'), 'utf8')).toBe('metadata')
    } finally {
      controller.abort()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it.each([
    [{ entries: 1 }, 'too many entries'],
    [{ extractedBytes: 10 }, 'expands beyond'],
    [{ archiveBytes: 1 }, 'compressed size']
  ])('enforces the %j budget before extracting anything', async (limits, error) => {
    const { source, destination } = await createBackup()
    await expect(
      extractBackupArchive(source, destination, {
        archiveBytes: 10_000,
        extractedBytes: 10_000,
        entries: 10,
        ...limits
      })
    ).rejects.toThrow(error)
    expect(await readdir(destination)).toEqual([])
  })
})
