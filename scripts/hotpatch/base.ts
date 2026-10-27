import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { HOTPATCH_APP_ID, type HotpatchBase, type HotpatchFile } from '../../packages/shared/hotpatch'
import { hotpatchDescriptorSchema, patchableSource } from '../../packages/shared/hotpatchBuild'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export async function inventory(root: string, skip: readonly string[] = []): Promise<HotpatchFile[]> {
  const result: HotpatchFile[] = []
  const visit = async (directory: string, prefix: string) => {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en')
    )) {
      const name = prefix ? `${prefix}/${item.name}` : item.name
      if (skip.includes(name)) continue
      if (item.isSymbolicLink()) throw new Error(`Build tree contains a symbolic link: ${name}`)
      if (item.isDirectory()) await visit(path.join(directory, item.name), name)
      else {
        const filename = path.join(directory, item.name),
          stat = await lstat(filename)
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Build tree contains a non-regular file')
        const data = await readFile(filename)
        result.push({ path: name, size: data.length, sha256: hash(data) })
      }
    }
  }
  await visit(root, '')
  return result
}

export async function writeBaseDescriptor(root = process.cwd()): Promise<void> {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  const sourceCommit = git('rev-parse', 'HEAD')
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true })
    .split('\0')
    .filter(Boolean)
    .sort()
  const frozenSources: Record<string, string> = {}
  for (const filename of files) {
    if (!patchableSource(filename)) frozenSources[filename] = hash(await readFile(path.join(root, filename)))
  }
  const main = await inventory(path.join(root, 'out/main'), ['hotpatch-base.json'])
  const preload = await inventory(path.join(root, 'out/preload'))
  const builtin = await inventory(path.join(root, 'out/renderer'))
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const shared = {
    appId: HOTPATCH_APP_ID,
    version: pkg.version as string,
    baseCommit: sourceCommit,
    channel: 'stable',
    mainFingerprint: hash(JSON.stringify(main)),
    preloadFingerprint: hash(JSON.stringify(preload)),
    runtimeFingerprint: hash(
      JSON.stringify({
        dependencies: pkg.dependencies,
        electron: pkg.devDependencies.electron,
        lock: frozenSources['pnpm-lock.yaml']
      })
    ),
    contractsFingerprint: hash(
      JSON.stringify(
        Object.entries(frozenSources).filter(([name]) =>
          /^(?:packages\/shared|src\/renderer\/src\/(?:store|databases|types))\//.test(name)
        )
      )
    ),
    securityFingerprint: hash(
      JSON.stringify(
        Object.entries(frozenSources).filter(([name]) =>
          /^(?:src\/main\/services\/(?:hotpatch|security)|src\/main\/services\/(?:WindowService|SelectionService|NodeTraceService))/.test(
            name
          )
        )
      )
    )
  }
  const bases: HotpatchBase[] = []
  for (const platform of ['win32', 'darwin', 'linux'] as const)
    for (const arch of ['x64', 'arm64'] as const) {
      for (const packaging of platform === 'win32' ? (['installed', 'portable'] as const) : (['installed'] as const)) {
        const identity = { ...shared, platform, arch, packaging }
        bases.push({ ...identity, baseBuildId: hash(JSON.stringify({ identity, builtin, frozenSources })) })
      }
    }
  const descriptor = hotpatchDescriptorSchema.parse({
    schemaVersion: 1,
    bases,
    builtin,
    frozenSources,
    sourceClean: git('status', '--porcelain') === ''
  })
  if (process.env.CI === 'true' && !descriptor.sourceClean)
    throw new Error('Installer base sources changed during CI build; refusing an unverifiable patch base')
  await writeFile(path.join(root, 'out/main/hotpatch-base.json'), JSON.stringify(descriptor))
  process.stdout.write(
    `Hotpatch base descriptor: ${pkg.version}; source clean: ${descriptor.sourceClean}; ${builtin.length} renderer files. Production delivery remains separately gated.\n`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  writeBaseDescriptor().catch((error) => {
    process.stderr.write(`${String(error)}\n`)
    process.exitCode = 1
  })
