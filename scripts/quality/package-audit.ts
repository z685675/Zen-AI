import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { planDigest } from './pricing'
import { execute, type ProcessResult } from './process'

export interface PackageTarget {
  resources: string
  platform: 'windows' | 'mac' | 'linux'
  arch: 'x64' | 'arm64'
  expectedVersion: string
  bundle?: string
  requireSignature?: boolean
}

async function hash(file: string) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}

export async function packageSnapshot(root: string, target: PackageTarget) {
  const resources = await realpath(target.resources)
  const archive = path.join(resources, 'app.asar')
  const info = await lstat(archive)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('缺少普通app.asar文件。')
  const require = createRequire(path.join(root, 'package.json'))
  const nativeOS = target.platform === 'mac' ? 'darwin' : target.platform
  const binary = path.join(
    resources,
    'opencode',
    `${nativeOS}-${target.arch}`,
    target.platform === 'windows' ? 'opencode.exe' : 'opencode'
  )
  await access(binary)
  const builder = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib'))
  const asar = builder('@electron/asar') as { extractFile(archive: string, file: string): Buffer }
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
  if (metadata.version !== target.expectedVersion)
    throw new Error(`安装包版本${metadata.version}与预期${target.expectedVersion}不一致。`)
  const verifier = require(path.join(root, 'scripts/agent-runtime-packaging.js')) as {
    verifyPackagedAgentRuntimes(
      resources: string,
      platform: string,
      arch: string
    ): { codexBinary: string; claudeBinary: string }
  }
  const paths = verifier.verifyPackagedAgentRuntimes(resources, target.platform, target.arch)
  // Hash the actual packaged executable/resources, never just the filename/tag.
  return {
    version: metadata.version,
    resources,
    archiveSha256: await hash(archive),
    runtimeSha256: await hash(binary),
    runtimeHashes: { codex: await hash(paths.codexBinary), claude: await hash(paths.claudeBinary) },
    bytes: info.size,
    platform: target.platform,
    arch: target.arch
  }
}

export async function auditPackage(
  root: string,
  target: PackageTarget,
  signal?: AbortSignal,
  approved?: Awaited<ReturnType<typeof packageSnapshot>>
) {
  const before = await packageSnapshot(root, target)
  if (approved && planDigest(before) !== planDigest(approved))
    throw new Error('批准后安装包或内核被替换，未执行；请重新预览。')
  const steps: Array<{ id: string; file: string; args: string[] }> = [
    {
      id: 'native-resources',
      file: process.execPath,
      args: [
        path.join(root, 'scripts/check-packaged-agent-runtimes.js'),
        before.resources,
        target.platform,
        target.arch
      ]
    }
  ]
  if (target.platform === 'mac') {
    if (!target.bundle) throw new Error('Mac安装包检查必须明确.app目录。')
    steps.push({
      id: 'bundle-links',
      file: process.execPath,
      args: [
        '-e',
        'require(process.argv[1]).verifyMacBundleLinks(process.argv[2])',
        path.join(root, 'scripts/mac-bundle-links.js'),
        target.bundle
      ]
    })
    if (target.requireSignature) {
      if (process.platform !== 'darwin') throw new Error('Mac签名必须在Mac runner验证，不能跨平台冒充通过。')
      steps.push({
        id: 'codesign',
        file: '/usr/bin/codesign',
        args: ['--verify', '--deep', '--strict', '--verbose=2', target.bundle]
      })
    }
  }
  const observations: Array<ProcessResult & { id: string }> = []
  for (const step of steps) {
    const result = await execute({ ...step, cwd: root }, { signal, timeoutMs: 120000, maxOutputBytes: 1024 * 1024 })
    observations.push({ id: step.id, ...result })
    if (
      result.exitCode !== 0 ||
      result.signal ||
      result.timedOut ||
      result.cancelled ||
      result.error ||
      result.terminationUnconfirmed
    )
      throw new Error(`安装包${step.id}失败：${result.error ?? result.stderr.slice(-4000)}`)
  }
  const after = await packageSnapshot(root, target)
  if (
    after.archiveSha256 !== before.archiveSha256 ||
    after.runtimeSha256 !== before.runtimeSha256 ||
    after.runtimeHashes.codex !== before.runtimeHashes.codex ||
    after.runtimeHashes.claude !== before.runtimeHashes.claude
  )
    throw new Error('验收期间安装包被替换。')
  return {
    ...before,
    observations,
    installedAppInteraction: 'manual-required',
    signatureChecked: target.platform === 'mac' && Boolean(target.requireSignature),
    hostRuntimeExecuted:
      target.arch === process.arch &&
      target.platform ===
        ({ win32: 'windows', darwin: 'mac', linux: 'linux' } as Record<string, string>)[process.platform]
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const [resources, platform, arch, expectedVersion, bundle] = process.argv.slice(2)
  Promise.resolve()
    .then(async () => {
      if (
        !resources ||
        !['windows', 'mac', 'linux'].includes(platform) ||
        !['x64', 'arm64'].includes(arch) ||
        !/^\d+\.\d+\.\d+/.test(expectedVersion ?? '')
      )
        throw new Error('用法：quality:package resources目录 windows|mac|linux x64|arm64 版本 [Mac.app目录]')
      return auditPackage(path.resolve(__dirname, '../..'), {
        resources: path.resolve(resources),
        platform: platform as PackageTarget['platform'],
        arch: arch as PackageTarget['arch'],
        expectedVersion,
        bundle
      })
    })
    .then((result) => process.stdout.write(JSON.stringify(result, null, 2) + '\n'))
    .catch((error) => {
      process.stderr.write(String(error) + '\n')
      process.exitCode = 1
    })
}
