import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { checkFrozenSources } from '../../../../../scripts/hotpatch/artifact'
import { inventory } from '../../../../../scripts/hotpatch/base'
import { sha256 } from '../verification'
import { base, makeArtifact } from './fixtures'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'zen-hotpatch-qualification-'))
  roots.push(root)
  const write = async (name: string, body: string) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), body)
  }
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Isolated Hotpatch Test',
        '-c',
        'user.email=hotpatch-test@invalid.local',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.autocrlf=false',
        ...args
      ],
      { cwd: root, encoding: 'utf8', windowsHide: true }
    ).trim()
  const commit = () => {
    git('add', '.')
    git('commit', '-qm', 'isolated fixture')
  }
  git('init', '-q')
  await write('.gitignore', 'out/\n')
  await write('package.json', '{"name":"isolated-test","version":"1.2.0"}\n')
  await write('src/main/index.ts', '// frozen main\n')
  await write('src/preload/index.ts', '// frozen preload\n')
  await write('src/renderer/src/pages/demo.tsx', '// original UI\n')
  await write('out/main/index.js', 'compiled-main')
  await write('out/preload/index.js', 'compiled-preload')
  commit()
  const frozenSources: Record<string, string> = {}
  for (const name of ['.gitignore', 'package.json', 'src/main/index.ts', 'src/preload/index.ts'])
    frozenSources[name] = sha256(await readFile(path.join(root, name)))
  const descriptor = {
    schemaVersion: 1 as const,
    sourceClean: true,
    frozenSources,
    builtin: makeArtifact().files,
    bases: [
      {
        ...base,
        baseCommit: git('rev-parse', 'HEAD'),
        mainFingerprint: sha256(JSON.stringify(await inventory(path.join(root, 'out/main')))),
        preloadFingerprint: sha256(JSON.stringify(await inventory(path.join(root, 'out/preload'))))
      }
    ]
  }
  return { root, write, commit, descriptor }
}

it('accepts a clean descendant with only eligible UI edits and identical compiled privileged code', async () => {
  const test = await fixture()
  await test.write('src/renderer/src/pages/demo.tsx', '// repaired layout\n')
  test.commit()
  await expect(checkFrozenSources(test.descriptor, test.root)).resolves.toBeUndefined()
  await test.write('out/preload/index.js', 'changed-compiled-preload')
  await expect(checkFrozenSources(test.descriptor, test.root)).rejects.toThrow('Compiled main/preload')
})

it('refuses dirty sources and dependency changes even when the version number is unchanged', async () => {
  const test = await fixture()
  await test.write('package.json', '{"name":"isolated-test","version":"1.2.0","dependencies":{"new-native":"1"}}\n')
  await expect(checkFrozenSources(test.descriptor, test.root)).rejects.toThrow('clean reviewed')
  test.commit()
  await expect(checkFrozenSources(test.descriptor, test.root)).rejects.toThrow('frozen source changed')
})

it('refuses a newly introduced state schema file instead of treating it as a frontend-only change', async () => {
  const test = await fixture()
  await test.write('src/renderer/src/store/newSlice.ts', '// changed storage contract\n')
  test.commit()
  await expect(checkFrozenSources(test.descriptor, test.root)).rejects.toThrow('frozen source inventory')
})
