import { createWriteStream } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { HOTPATCH_ENTRIES } from '@shared/hotpatch'
import archiver from 'archiver'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { extractSnapshot, verifySnapshot } from '../archive'
import { downloadArchive, fetchHotpatch, readBoundedResponse } from '../download'
import { createSecureFileFallback, createSnapshotResourceHandler, readSnapshotFile } from '../resources'
import { sha256 } from '../verification'
import { makeArtifact } from './fixtures'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
const directories: string[] = []
async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), 'zen-hotpatch-unit-'))
  directories.push(value)
  return value
}
afterEach(async () => {
  for (const value of directories.splice(0)) await rm(value, { recursive: true, force: true })
})
const signal = () => new AbortController().signal
it('does not execute scripts/documents outside the immutable renderer root, but preserves attachment reads', async () => {
  const fetcher = vi.fn(async () => new Response('attachment'))
  const fallback = createSecureFileFallback('C:/application/renderer', fetcher)
  expect((await fallback(new Request('file:///C:/Downloads/foreign.js'))).status).toBe(403)
  expect((await fallback(new Request('file:///C:/Downloads/foreign.html'))).status).toBe(403)
  const attachment = await fallback(new Request('file:///C:/Downloads/report.pdf'))
  expect(await attachment.text()).toBe('attachment')
  expect(attachment.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
async function zipFile(file: string, entries: Array<{ name: string; data: string; mode?: number }>) {
  const output = createWriteStream(file),
    archive = archiver('zip')
  const completed = new Promise<void>((resolve, reject) => {
    output.on('close', resolve)
    output.on('error', reject)
    archive.on('error', reject)
  })
  archive.pipe(output)
  for (const entry of entries) archive.append(entry.data, { name: entry.name, mode: entry.mode ?? 0o644 })
  await archive.finalize()
  await completed
  // archiver normalizes file kinds. Mutate the central directory to model a real hostile ZIP.
  const symbolic = entries.find((entry) => entry.mode === 0o120777)
  if (symbolic) {
    const bytes = await readFile(file)
    for (let offset = 0; offset + 46 <= bytes.length; offset++) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50) continue
      const length = bytes.readUInt16LE(offset + 28)
      if (bytes.subarray(offset + 46, offset + 46 + length).toString() === symbolic.name) {
        bytes.writeUInt16LE(0x031e, offset + 4)
        bytes.writeUInt32LE((0o120777 << 16) >>> 0, offset + 38)
        break
      }
    }
    await writeFile(file, bytes)
  }
}

describe('bounded hotpatch file pipeline', () => {
  it('limits actual body bytes, rejects truncation/hashes, writes archives exclusively', async () => {
    expect((await readBoundedResponse(new Response('okay'), 4)).toString()).toBe('okay')
    await expect(readBoundedResponse(new Response('too-large'), 4)).rejects.toThrow('limit')
    await expect(readBoundedResponse(new Response('x', { headers: { 'content-length': '99' } }), 4)).rejects.toThrow(
      'limit'
    )
    const root = await directory(),
      file = path.join(root, 'archive.zip'),
      expected = { size: 4, sha256: sha256('okay') }
    await downloadArchive(new Response('okay'), file, expected, signal())
    expect((await readFile(file)).toString()).toBe('okay')
    await expect(downloadArchive(new Response('okay'), file, expected, signal())).rejects.toThrow()
    await expect(downloadArchive(new Response('bad!'), path.join(root, 'bad.zip'), expected, signal())).rejects.toThrow(
      'hash'
    )
    await expect(
      downloadArchive(new Response('more!'), path.join(root, 'big.zip'), expected, signal())
    ).rejects.toThrow('size')
  })
  it('does not forward cookies/keys, bounds redirects and refuses outside redirects before fetching', async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/stolen' } })
    )
    await expect(
      fetchHotpatch(
        fetcher,
        'https://download.925636.xyz/zen-ai/hotpatch/a',
        ['https://download.925636.xyz/zen-ai/hotpatch/'],
        signal()
      )
    ).rejects.toThrow('allowlist')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      credentials: 'omit',
      redirect: 'manual',
      headers: { Accept: expect.any(String) }
    })
    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/zen-ai/hotpatch/a' } }))
    await expect(
      fetchHotpatch(
        loop,
        'https://download.925636.xyz/zen-ai/hotpatch/a',
        ['https://download.925636.xyz/zen-ai/hotpatch/'],
        signal()
      )
    ).rejects.toThrow('limit')
    expect(loop).toHaveBeenCalledTimes(4)
  })
  it('extracts a complete signed inventory and rejects duplicate, unlisted, corrupt and symbolic entries', async () => {
    const root = await directory(),
      contents = Object.fromEntries(HOTPATCH_ENTRIES.map((name) => [name, 'verified'])),
      artifact = makeArtifact(contents)
    const valid = Object.entries(contents).map(([name, data]) => ({ name, data }))
    for (const [name, entries, good] of [
      ['good', valid, true],
      ['duplicate', [...valid, valid[0]], false],
      ['extra', [...valid, { name: 'extra.js', data: 'bad' }], false],
      ['hash', valid.map((entry) => ({ ...entry, data: 'modified' })), false],
      ['symlink', valid.map((entry, index) => (index ? entry : { ...entry, mode: 0o120777 })), false]
    ] as const) {
      const zip = path.join(root, `${name}.zip`),
        out = path.join(root, name)
      await zipFile(zip, [...entries])
      await mkdir(out)
      if (good) {
        await extractSnapshot(zip, out, artifact, signal())
        await verifySnapshot(out, artifact)
      } else await expect(extractSnapshot(zip, out, artifact, signal())).rejects.toThrow()
    }
    const truncated = path.join(root, 'truncated.zip'),
      out = path.join(root, 'truncated')
    await writeFile(truncated, (await readFile(path.join(root, 'good.zip'))).subarray(0, 50))
    await mkdir(out)
    await expect(extractSnapshot(truncated, out, artifact, signal())).rejects.toThrow('ZIP')
    const excessive = await readFile(path.join(root, 'good.zip'))
    const eocd = excessive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    excessive.writeUInt16LE(60000, eocd + 8)
    excessive.writeUInt16LE(60000, eocd + 10)
    const excessiveZip = path.join(root, 'too-many-central-entries.zip')
    await writeFile(excessiveZip, excessive)
    await expect(extractSnapshot(excessiveZip, out, artifact, signal())).rejects.toThrow('signed entry bounds')
  })
  it('rehashes actual resource bytes and never silently mixes bundled/patch chunks', async () => {
    const root = await directory(),
      original = await directory(),
      file = { path: 'entry.js', size: 4, sha256: sha256('good') }
    await writeFile(path.join(root, file.path), 'good')
    const fallback = vi.fn(async () => new Response('untouched'))
    const handler = createSnapshotResourceHandler({
      originalRoot: original,
      snapshotRoot: root,
      files: [file],
      fallback
    })
    const url = new URL(`file:///${path.join(original, file.path).replaceAll('\\', '/')}`)
    expect((await handler(new Request(url))).status).toBe(200)
    await writeFile(path.join(root, file.path), 'evil')
    expect((await handler(new Request(url))).status).toBe(500)
    expect((await handler(new Request(new URL('missing.js', url)))).status).toBe(500)
    expect(fallback).not.toHaveBeenCalled()
    expect((await handler(new Request(new URL('../user-document.pdf', url)))).status).toBe(200)
    expect(fallback).toHaveBeenCalledTimes(1)
  })
  it('rejects filesystem hard links, symlinks, extra/missing files and byte changes after validation', async () => {
    const root = await directory(),
      file = { path: 'data.js', size: 4, sha256: sha256('data') }
    await writeFile(path.join(root, file.path), 'data')
    await link(path.join(root, file.path), path.join(root, 'linked.js'))
    await expect(readSnapshotFile(root, file)).rejects.toThrow('type')
    await rm(path.join(root, 'linked.js'))
    const target = await directory()
    await writeFile(path.join(target, file.path), 'data')
    await symlink(target, path.join(root, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(readSnapshotFile(root, { ...file, path: 'linked-directory/data.js' })).rejects.toThrow('links')
    await rm(path.join(root, 'linked-directory'))
    const artifact = makeArtifact()
    await expect(verifySnapshot(root, artifact)).rejects.toThrow('Unlisted')
  })
})
