import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import AdmZip from 'adm-zip'

import { HOTPATCH_LIMITS } from '../../packages/shared/hotpatch'
import { type HotpatchDescriptor, hotpatchDescriptorSchema } from '../../packages/shared/hotpatchBuild'
import { safeSnapshotPath } from '../../src/main/services/hotpatch/resources'
import { inventory } from './base'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const directories = ['main', 'preload'] as const

async function verifyRuntime(root: string, descriptor: HotpatchDescriptor): Promise<void> {
  for (const directory of directories) {
    const files = await inventory(path.join(root, directory), directory === 'main' ? ['hotpatch-base.json'] : [])
    const fingerprint = hash(JSON.stringify(files))
    if (!files.length || descriptor.bases.some((base) => base[`${directory}Fingerprint`] !== fingerprint))
      throw new Error(`Frozen ${directory} does not match the exact installer descriptor`)
  }
}

/** Preserve every compiled file, including assets referenced by main/preload. Never rebuild this baseline. */
export async function packRuntime(root: string, descriptorFile: string, output: string): Promise<void> {
  const descriptor = hotpatchDescriptorSchema.parse(JSON.parse(await readFile(descriptorFile, 'utf8')))
  if (!descriptor.sourceClean) throw new Error('Only a clean release build can become a frozen runtime')
  const compiled = path.join(root, 'out')
  await verifyRuntime(compiled, descriptor)
  const zip = new AdmZip()
  for (const directory of directories)
    for (const file of await inventory(
      path.join(compiled, directory),
      directory === 'main' ? ['hotpatch-base.json'] : []
    ))
      zip.addFile(`${directory}/${file.path}`, await readFile(path.join(compiled, directory, file.path)))
  const bytes = zip.toBuffer()
  if (bytes.length > HOTPATCH_LIMITS.archiveBytes) throw new Error('Frozen runtime archive exceeds limit')
  await writeFile(output, bytes, { flag: 'wx' })
}

/** Restore only a verified release runtime. Source eligibility is still enforced separately by artifact.ts. */
export async function restoreRuntime(root: string, descriptorFile: string, archiveFile: string): Promise<void> {
  const descriptorBytes = await readFile(descriptorFile)
  const descriptor = hotpatchDescriptorSchema.parse(JSON.parse(descriptorBytes.toString('utf8')))
  if (!descriptor.sourceClean) throw new Error('A dirty installer baseline cannot be restored')
  if ((await stat(archiveFile)).size > HOTPATCH_LIMITS.archiveBytes)
    throw new Error('Frozen runtime archive exceeds limit')
  const entries = new AdmZip(await readFile(archiveFile)).getEntries()
  if (!entries.length || entries.length > HOTPATCH_LIMITS.fileCount)
    throw new Error('Invalid frozen runtime file count')
  const seen = new Set<string>()
  let expanded = 0
  // Inspect the entire archive before writing any paths, including portable case collisions and links.
  for (const entry of entries) {
    const name = entry.entryName
    const mode = (entry.attr >>> 16) & 0o170000
    if (
      !safeSnapshotPath(name) ||
      !/^(main|preload)\/.+/.test(name) ||
      name === 'main/hotpatch-base.json' ||
      entry.isDirectory ||
      (mode !== 0 && mode !== 0o100000) ||
      seen.has(name.toLowerCase()) ||
      entry.header.size > HOTPATCH_LIMITS.fileBytes
    )
      throw new Error('Unsafe or duplicate frozen runtime entry')
    seen.add(name.toLowerCase())
    expanded += entry.header.size
    if (expanded > HOTPATCH_LIMITS.expandedBytes) throw new Error('Frozen runtime expands beyond limit')
  }
  const local = path.join(path.resolve(root), 'local')
  await mkdir(local, { recursive: true })
  if ((await lstat(local)).isSymbolicLink()) throw new Error('Local staging directory must not be a link')
  const stage = await mkdtemp(path.join(local, 'hotpatch-runtime-'))
  for (const entry of entries) {
    const filename = path.join(stage, ...entry.entryName.split('/'))
    const bytes = entry.getData()
    if (bytes.length !== entry.header.size) throw new Error('Frozen runtime file size mismatch')
    await mkdir(path.dirname(filename), { recursive: true })
    await writeFile(filename, bytes, { flag: 'wx' })
  }
  await verifyRuntime(stage, descriptor)
  await writeFile(path.join(stage, 'main/hotpatch-base.json'), descriptorBytes, { flag: 'wx' })
  const output = path.join(path.resolve(root), 'out')
  for (const directory of [output, ...directories.map((name) => path.join(output, name))]) {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Compiled output must be a regular directory')
  }
  const moved: string[] = []
  const installed: string[] = []
  try {
    for (const directory of directories) {
      await rename(path.join(output, directory), path.join(stage, `previous-${directory}`))
      moved.push(directory)
      await rename(path.join(stage, directory), path.join(output, directory))
      installed.push(directory)
    }
  } catch (error) {
    for (const directory of installed.reverse())
      await rename(path.join(output, directory), path.join(stage, `failed-${directory}`))
    for (const directory of moved.reverse())
      await rename(path.join(stage, `previous-${directory}`), path.join(output, directory))
    throw error
  }
  process.stdout.write(
    'Restored verified installer main/preload; renderer output and frozen-source checks preserved.\n'
  )
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      descriptor: { type: 'string' },
      archive: { type: 'string' }
    }
  })
  if (!values.descriptor || !values.archive) throw new Error('Missing --descriptor or --archive')
  if (values.mode === 'pack') await packRuntime(process.cwd(), values.descriptor, values.archive)
  else if (values.mode === 'restore') await restoreRuntime(process.cwd(), values.descriptor, values.archive)
  else throw new Error('Use --mode pack or --mode restore')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write(`${String(error)}\n`)
    process.exitCode = 1
  })
