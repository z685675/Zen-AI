import { createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { HOTPATCH_ENTRIES } from '@shared/hotpatch'
import archiver from 'archiver'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HotpatchEngine } from '../engine'
import { SnapshotRepository } from '../repository'
import { HotpatchStateStore } from '../state'
import { sha256 } from '../verification'
import { base, makeArtifact, makePolicy, now, signingFixture } from './fixtures'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'zen-hotpatch-engine-'))
  roots.push(root)
  const contents = Object.fromEntries(HOTPATCH_ENTRIES.map((name) => [name, '<!doctype html><p>patched</p>']))
  const zipPath = path.join(root, 'fixture.zip'),
    output = createWriteStream(zipPath),
    zip = archiver('zip')
  const complete = new Promise<void>((resolve, reject) => {
    output.on('close', resolve)
    zip.on('error', reject)
    output.on('error', reject)
  })
  zip.pipe(output)
  for (const [name, data] of Object.entries(contents)) zip.append(data, { name })
  await zip.finalize()
  await complete
  const archive = await readFile(zipPath),
    signed = signingFixture(),
    artifact = makeArtifact(contents)
  artifact.archive.size = archive.length
  artifact.archive.sha256 = sha256(archive)
  const metadata = signed.encode('artifact', artifact),
    policy = makePolicy()
  policy.target!.manifestSha256 = sha256(metadata)
  const policyUrl = 'https://zenai.925636.xyz/api/client/patch-policy'
  let policyBytes = signed.encode('policy', policy)
  const fetcher = vi.fn(async (url: string) => {
    if (url === policyUrl) return new Response(new Uint8Array(policyBytes))
    if (url === policy.target!.manifestUrl) return new Response(new Uint8Array(metadata))
    if (url === artifact.archive.url) return new Response(new Uint8Array(archive))
    throw new Error('unexpected URL')
  })
  const store = await HotpatchStateStore.load(path.join(root, 'state'), base.baseBuildId)
  const repository = new SnapshotRepository({
    root: path.join(store.root, 'snapshots'),
    base,
    builtin: artifact.files,
    trust: signed.trust,
    allowed: ['https://download.925636.xyz/zen-ai/hotpatch/'],
    fetcher
  })
  let time = now * 1000
  const engine = new HotpatchEngine({
    base,
    trust: signed.trust,
    policyUrl,
    allowedPolicy: [policyUrl],
    fetcher,
    repository,
    store,
    now: () => time
  })
  return {
    root,
    engine,
    store,
    repository,
    policy,
    fetcher,
    setTime: (value: number) => {
      time = value
    },
    setPolicy: () => {
      policyBytes = signed.encode('policy', policy)
    }
  }
}

describe('offline end-to-end signed patch lifecycle', () => {
  it('cleans only old unreferenced snapshots, preserving pins, fresh downloads, foreign data and links', async () => {
    const test = await fixture(),
      root = path.join(test.store.root, 'snapshots')
    await mkdir(root)
    const refs = Array.from({ length: 6 }, (_, i) => ({ patchId: `patch.${i}`, manifestSha256: String(i).repeat(64) }))
    const names = refs.map((ref) => `${ref.patchId}-${ref.manifestSha256}`)
    for (const [i, name] of names.entries()) {
      const directory = path.join(root, name)
      await mkdir(directory)
      await utimes(directory, 10 + i, 10 + i)
    }
    const oldStaging = 'staging-' + 'a'.repeat(32),
      freshStaging = 'staging-' + 'b'.repeat(32)
    for (const name of [oldStaging, freshStaging, 'not-a-patch']) await mkdir(path.join(root, name))
    await utimes(path.join(root, oldStaging), 10, 10)
    const outside = path.join(test.root, 'external-user-files')
    await mkdir(outside)
    await writeFile(path.join(outside, 'keep.txt'), 'user data')
    const linked = 'linked-' + 'c'.repeat(64)
    await symlink(outside, path.join(root, linked), process.platform === 'win32' ? 'junction' : 'dir')
    await test.repository.prune([refs[0], null])
    const remaining = await readdir(root)
    expect(remaining).toEqual(
      expect.arrayContaining([names[0], names[4], names[5], freshStaging, 'not-a-patch', linked])
    )
    for (const name of [names[1], names[2], names[3], oldStaging]) expect(remaining).not.toContain(name)
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('user data')
    expect((await lstat(path.join(root, linked))).isSymbolicLink()).toBe(true)
  })
  it('downloads, verifies, stages, activates on next startup, preserves a healthy patch when offline/expired', async () => {
    const test = await fixture()
    expect(await test.engine.check(new AbortController().signal)).toBe(true)
    expect(test.store.snapshot.active).toBeNull()
    expect(test.fetcher).toHaveBeenCalledTimes(3)
    const boot = await test.engine.select()
    expect(boot.snapshot?.artifact.patchId).toBe('patch.1')
    expect(await test.store.healthy(boot.challenge!)).toBe(true)
    test.setTime((now + 100000) * 1000)
    test.fetcher.mockRejectedValue(new Error('offline'))
    expect((await test.engine.select()).snapshot?.artifact.patchId).toBe('patch.1')
  })
  it('rejects expired pending activation, bad metadata and unsigned HTTP success without changing active', async () => {
    const test = await fixture()
    await test.engine.check(new AbortController().signal)
    test.setTime((now + 4000) * 1000)
    expect((await test.engine.select()).snapshot).toBeUndefined()
    expect(test.store.snapshot.pending).toBeNull()
    test.setTime(now * 1000)
    test.fetcher.mockResolvedValue(new Response('unsigned success'))
    await expect(test.engine.check(new AbortController().signal)).rejects.toThrow('Malformed')
    expect(test.store.snapshot.active).toBeNull()
  })
  it('quarantines a tampered file before loading renderer code and falls back to builtin', async () => {
    const test = await fixture()
    await test.engine.check(new AbortController().signal)
    const downloaded = await test.repository.load(test.store.snapshot.pending!.target!)
    await writeFile(path.join(downloaded.root, 'index.html'), '<p>tampered</p>')
    expect((await test.engine.select()).snapshot).toBeUndefined()
    expect(test.store.snapshot.quarantined).toHaveLength(1)
    expect(await test.engine.check(new AbortController().signal)).toBe(false)
  })
  it('deduplicates simultaneous checks, handles pause and applies signed builtin rollback only next startup', async () => {
    const test = await fixture(),
      signal = new AbortController().signal
    await Promise.all([test.engine.check(signal), test.engine.check(signal), test.engine.check(signal)])
    expect(test.fetcher).toHaveBeenCalledTimes(3)
    const boot = await test.engine.select()
    await test.store.healthy(boot.challenge!)
    test.policy.policySequence = 2
    test.policy.action = 'pause'
    test.policy.target = null
    test.setPolicy()
    expect(await test.engine.check(signal)).toBe(false)
    expect(test.store.snapshot.active?.patchId).toBe('patch.1')
    test.policy.policySequence = 3
    test.policy.action = 'rollback'
    test.setPolicy()
    expect(await test.engine.check(signal)).toBe(true)
    expect(test.store.snapshot.active?.patchId).toBe('patch.1')
    expect((await test.engine.select()).snapshot).toBeUndefined()
  })
  it('keeps an excluded client on builtin without downloading artifacts', async () => {
    const test = await fixture()
    test.policy.rollout.basisPoints = 0
    test.setPolicy()
    expect(await test.engine.check(new AbortController().signal)).toBe(false)
    expect(test.fetcher).toHaveBeenCalledTimes(1)
    expect(test.store.snapshot.highestSequence).toBe(1)
  })
})
