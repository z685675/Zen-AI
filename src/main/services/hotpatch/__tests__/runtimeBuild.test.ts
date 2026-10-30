import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { HOTPATCH_ENTRIES } from '@shared/hotpatch'
import type { HotpatchDescriptor } from '@shared/hotpatchBuild'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkFrozenSources } from '../../../../../scripts/hotpatch/artifact'
import { inventory } from '../../../../../scripts/hotpatch/base'
import { packRuntime, restoreRuntime } from '../../../../../scripts/hotpatch/runtime'
import { sha256 } from '../verification'
import { base } from './fixtures'

vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:child_process')

const temporary: string[] = []
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zen-frozen-runtime-'))
  temporary.push(root)
  for (const directory of ['main', 'preload', 'renderer'])
    await mkdir(path.join(root, 'out', directory), { recursive: true })
  await writeFile(path.join(root, 'out/main/index.js'), 'require("./tray_icon_dark.png")')
  await writeFile(path.join(root, 'out/main/tray_icon_dark.png'), 'original tray asset')
  await writeFile(path.join(root, 'out/preload/index.js'), 'original bridge')
  await writeFile(path.join(root, 'out/renderer/index.html'), 'new renderer')
  const descriptor: HotpatchDescriptor = {
    schemaVersion: 1,
    bases: [
      {
        ...base,
        mainFingerprint: sha256(JSON.stringify(await inventory(path.join(root, 'out/main')))),
        preloadFingerprint: sha256(JSON.stringify(await inventory(path.join(root, 'out/preload'))))
      }
    ],
    builtin: HOTPATCH_ENTRIES.map((name) => ({ path: name, size: 1, sha256: '0'.repeat(64) })),
    frozenSources: {},
    sourceClean: true
  }
  const descriptorFile = path.join(root, 'descriptor.json')
  const archive = path.join(root, 'runtime.zip')
  await writeFile(descriptorFile, JSON.stringify(descriptor))
  return { root, descriptor, descriptorFile, archive }
}

describe('exact installer runtime preservation', () => {
  it('restores all original main/preload bytes and tray assets while retaining the new renderer', async () => {
    const { root, descriptorFile, archive } = await fixture()
    await packRuntime(root, descriptorFile, archive)
    await writeFile(path.join(root, 'out/main/index.js'), 'different rebuilt bytes')
    await writeFile(path.join(root, 'out/main/stale.js'), 'unexpected rebuilt output')
    await writeFile(path.join(root, 'out/preload/index.js'), 'different bridge')
    await restoreRuntime(root, descriptorFile, archive)
    expect(await readFile(path.join(root, 'out/main/index.js'), 'utf8')).toContain('tray_icon_dark.png')
    expect(await readFile(path.join(root, 'out/main/tray_icon_dark.png'), 'utf8')).toBe('original tray asset')
    expect(await readFile(path.join(root, 'out/preload/index.js'), 'utf8')).toBe('original bridge')
    expect(await readFile(path.join(root, 'out/renderer/index.html'), 'utf8')).toBe('new renderer')
    await expect(readFile(path.join(root, 'out/main/stale.js'))).rejects.toThrow()
    expect(await readFile(path.join(root, 'out/main/hotpatch-base.json'))).toEqual(await readFile(descriptorFile))
  })

  it('rejects tampered or incomplete archives before replacing compiled output', async () => {
    for (const damage of ['tamper', 'missing']) {
      const { root, descriptorFile, archive } = await fixture()
      await packRuntime(root, descriptorFile, archive)
      const zip = new AdmZip(await readFile(archive))
      if (damage === 'tamper') zip.updateFile('main/index.js', Buffer.from('unreviewed'))
      else zip.deleteFile('main/tray_icon_dark.png')
      await writeFile(archive, zip.toBuffer())
      await writeFile(path.join(root, 'out/main/index.js'), 'keep this output')
      await expect(restoreRuntime(root, descriptorFile, archive)).rejects.toThrow('exact installer')
      expect(await readFile(path.join(root, 'out/main/index.js'), 'utf8')).toBe('keep this output')
    }
  })

  it('rejects unsafe paths, unexpected files, case collisions and archive-provided descriptors', async () => {
    for (const name of [
      '../escape',
      'main/../escape',
      'renderer/index.html',
      'main/INDEX.js',
      'main/hotpatch-base.json'
    ]) {
      const { root, descriptorFile, archive } = await fixture()
      await packRuntime(root, descriptorFile, archive)
      const zip = new AdmZip(await readFile(archive))
      zip.addFile(name, Buffer.from('unreviewed'))
      await writeFile(archive, zip.toBuffer())
      await expect(restoreRuntime(root, descriptorFile, archive)).rejects.toThrow('Unsafe')
    }
  })

  it('refuses to freeze a dirty or mismatched installer build', async () => {
    const { root, descriptor, descriptorFile, archive } = await fixture()
    await writeFile(descriptorFile, JSON.stringify({ ...descriptor, sourceClean: false }))
    await expect(packRuntime(root, descriptorFile, archive)).rejects.toThrow('clean release')
    await writeFile(descriptorFile, JSON.stringify(descriptor))
    await writeFile(path.join(root, 'out/main/tray_icon_dark.png'), 'changed')
    await expect(packRuntime(root, descriptorFile, archive)).rejects.toThrow('exact installer')
  })

  it('continues rejecting frozen source changes after restoring matching compiled output', async () => {
    const { root, descriptor, descriptorFile, archive } = await fixture()
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).trim()
    await writeFile(path.join(root, '.gitignore'), 'out/\nlocal/\ndescriptor.json\nruntime.zip\n')
    await writeFile(path.join(root, 'main-source.ts'), 'reviewed main code')
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'baseline')
    descriptor.bases[0].baseCommit = git('rev-parse', 'HEAD')
    descriptor.frozenSources = {
      '.gitignore': sha256(await readFile(path.join(root, '.gitignore'))),
      'main-source.ts': sha256(await readFile(path.join(root, 'main-source.ts')))
    }
    await writeFile(descriptorFile, JSON.stringify(descriptor))
    await packRuntime(root, descriptorFile, archive)
    await restoreRuntime(root, descriptorFile, archive)
    await expect(checkFrozenSources(descriptor, root)).resolves.toBeUndefined()
    await writeFile(path.join(root, 'main-source.ts'), 'unreviewed native capability')
    git('add', 'main-source.ts')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'change')
    await expect(checkFrozenSources(descriptor, root)).rejects.toThrow('Full installer required')
  })
})
