import { execFileSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import archiver from 'archiver'

import {
  HOTPATCH_LIMITS,
  type HotpatchArtifact,
  hotpatchArtifactSchema,
  type HotpatchBase
} from '../../packages/shared/hotpatch'
import { hotpatchDescriptorSchema, patchableSource } from '../../packages/shared/hotpatchBuild'
import { HOTPATCH_DOWNLOAD_PREFIX, HOTPATCH_PRODUCTION_TRUST } from '../../src/main/services/hotpatch/trust'
import {
  assertCompatible,
  assertDownloadUrl,
  sha256,
  validateArtifact,
  verifyEnvelope
} from '../../src/main/services/hotpatch/verification'
import { inventory } from './base'
import { signPayload } from './sign'

export async function checkFrozenSources(
  descriptor: ReturnType<typeof hotpatchDescriptorSchema.parse>,
  root: string
): Promise<void> {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  if (!descriptor.sourceClean || git('status', '--porcelain') !== '')
    throw new Error('Patch builds require clean reviewed sources and a clean base')
  execFileSync('git', ['merge-base', '--is-ancestor', descriptor.bases[0].baseCommit, 'HEAD'], {
    cwd: root,
    windowsHide: true
  })
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true })
    .split('\0')
    .filter(Boolean)
  const frozen = files.filter((name) => !patchableSource(name)).sort()
  if (frozen.join('\n') !== Object.keys(descriptor.frozenSources).sort().join('\n'))
    throw new Error('Patch changes the frozen source inventory')
  for (const name of frozen)
    if (sha256(await readFile(path.join(root, name))) !== descriptor.frozenSources[name])
      throw new Error(`Full installer required; frozen source changed: ${name}`)
  const main = await inventory(path.join(root, 'out/main'), ['hotpatch-base.json'])
  const preload = await inventory(path.join(root, 'out/preload'))
  if (
    sha256(JSON.stringify(main)) !== descriptor.bases[0].mainFingerprint ||
    sha256(JSON.stringify(preload)) !== descriptor.bases[0].preloadFingerprint
  )
    throw new Error('Compiled main/preload differ from the frozen installer; patch refused')
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: Object.fromEntries(
      ['descriptor', 'patch-id', 'platform', 'arch', 'packaging', 'output', 'key-id', 'notes'].map((name) => [
        name,
        { type: 'string' as const }
      ])
    )
  })
  for (const field of ['descriptor', 'patch-id', 'platform', 'arch', 'packaging', 'output', 'key-id'])
    if (!values[field]) throw new Error(`Missing --${field}`)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(values['patch-id']!)) throw new Error('Invalid immutable patch ID')
  const descriptor = hotpatchDescriptorSchema.parse(JSON.parse(await readFile(values.descriptor!, 'utf8')))
  await checkFrozenSources(descriptor, process.cwd())
  const base = descriptor.bases.find(
    (item) => item.platform === values.platform && item.arch === values.arch && item.packaging === values.packaging
  )
  if (!base) throw new Error('No matching exact base build in descriptor')
  const files = await inventory('out/renderer')
  const output = path.resolve(values.output!)
  await mkdir(output) // Fail instead of overwriting another artifact.
  const archiveFile = path.join(output, 'snapshot.zip'),
    stream = createWriteStream(archiveFile, { flags: 'wx' }),
    zip = archiver('zip', { zlib: { level: 9 } })
  const completed = new Promise<void>((resolve, reject) => {
    stream.on('close', resolve)
    stream.on('error', reject)
    zip.on('error', reject)
  })
  zip.pipe(stream)
  for (const file of files)
    zip.file(path.join('out/renderer', file.path), {
      name: file.path,
      mode: 0o644,
      date: new Date('1980-01-01T00:00:00Z')
    })
  await zip.finalize()
  await completed
  if ((await stat(archiveFile)).size > HOTPATCH_LIMITS.archiveBytes)
    throw new Error('Compressed snapshot exceeds its publication limit')
  const bytes = await readFile(archiveFile),
    hash = sha256(bytes)
  const prefix = `${HOTPATCH_DOWNLOAD_PREFIX}${base.baseBuildId}/${values['patch-id']}/`
  const artifact: HotpatchArtifact = {
    schemaVersion: 1,
    patchId: values['patch-id']!,
    base,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    createdAt: Math.floor(Date.now() / 1000),
    notes: values.notes ?? '',
    archive: { url: `${prefix}snapshot.zip`, sha256: hash, size: bytes.length },
    expandedSize: files.reduce((sum, file) => sum + file.size, 0),
    files
  }
  hotpatchArtifactSchema.parse(artifact)
  validateArtifact(artifact, base, descriptor.builtin)
  const pem = process.env.ZEN_HOTPATCH_SIGNING_KEY_PEM
  if (!pem) throw new Error('Protected signing key is not configured')
  const signed = signPayload(
    'artifact',
    Buffer.from(JSON.stringify(artifact)).toString('base64url'),
    values['key-id']!,
    pem,
    HOTPATCH_PRODUCTION_TRUST
  )
  verifyEnvelope(signed, 'artifact', HOTPATCH_PRODUCTION_TRUST)
  await writeFile(path.join(output, 'manifest.json'), signed, { flag: 'wx' })
  await writeFile(
    path.join(output, 'publication.json'),
    JSON.stringify({
      baseId: base.baseBuildId,
      patchId: artifact.patchId,
      manifestUrl: `${prefix}manifest.json`,
      manifestSha256: sha256(signed),
      archiveSha256: hash
    }),
    { flag: 'wx' }
  )
  process.stdout.write(
    `Signed patch ${artifact.patchId}; ${files.length} files; ${bytes.length} bytes. Not published by this command.\n`
  )
}

export async function verifyPublishedArtifact(
  manifestUrl: string,
  expectedHash: string,
  base?: HotpatchBase
): Promise<HotpatchArtifact> {
  assertDownloadUrl(manifestUrl, [HOTPATCH_DOWNLOAD_PREFIX])
  const response = await fetch(manifestUrl, { redirect: 'error', signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error('Published manifest is unreachable')
  const { readBoundedResponse } = await import('../../src/main/services/hotpatch/download')
  const signed = await readBoundedResponse(response, 2 * 1024 * 1024)
  if (sha256(signed) !== expectedHash) throw new Error('Published manifest bytes differ')
  const artifact = verifyEnvelope(signed, 'artifact', HOTPATCH_PRODUCTION_TRUST).value
  if (base) assertCompatible(base, artifact.base)
  assertDownloadUrl(artifact.archive.url, [HOTPATCH_DOWNLOAD_PREFIX])
  const archive = await fetch(artifact.archive.url, { redirect: 'error', signal: AbortSignal.timeout(120000) })
  if (!archive.ok) throw new Error('Published archive is unreachable')
  const bytes = await readBoundedResponse(archive, artifact.archive.size)
  if (bytes.length !== artifact.archive.size || sha256(bytes) !== artifact.archive.sha256)
    throw new Error('Published archive bytes differ')
  return artifact
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write(`${String(error)}\n`)
    process.exitCode = 1
  })
