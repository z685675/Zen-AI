import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import archiver from 'archiver'

import {
  MANAGED_PYTHON_PACKAGES,
  MANAGED_PYTHON_PROFILE_VERSION,
  MANAGED_PYTHON_VERSION
} from '../src/main/services/python/ManagedPythonConfig'
import {
  calculateRuntimeTreeMetadata,
  getManagedPythonRuntimeAssetName,
  MANAGED_PYTHON_RUNTIME_FORMAT,
  MANAGED_PYTHON_RUNTIME_SCHEMA_VERSION
} from '../src/main/services/python/ManagedPythonRuntimePackage'

const platform = process.platform
const arch = process.arch
if (!['win32', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
  throw new Error(`Unsupported runtime build target: ${platform}-${arch}`)
}

const repoRoot = path.resolve(import.meta.dirname, '..')
const outputDir = path.resolve(process.env.ZEN_RUNTIME_OUTPUT_DIR || path.join(repoRoot, 'dist', 'python-runtime'))
const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-python-runtime-build-'))
const installationsDir = path.join(workDir, 'installations')
const payloadDir = path.join(workDir, 'payload')
const runtimeDir = path.join(payloadDir, 'runtime')
const assetName = getManagedPythonRuntimeAssetName(platform, arch)
const assetPath = path.join(outputDir, assetName)

function run(executable: string, args: string[], options: { env?: NodeJS.ProcessEnv; capture?: boolean } = {}) {
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 10 * 1024 * 1024
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed: ${(result.stderr || '').trim()}`)
  }
  return (result.stdout || '').trim()
}

async function calculateFileSha256(filePath: string) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function createZip(sourceDir: string, destinationPath: string) {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(destinationPath, { flags: 'wx' })
    const archive = archiver('zip', { zlib: { level: 6 } })
    output.on('close', resolve)
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    archive.directory(path.join(sourceDir, 'runtime'), 'runtime')
    archive.file(path.join(sourceDir, 'manifest.json'), { name: 'manifest.json' })
    void archive.finalize()
  })
}

try {
  await fsp.mkdir(installationsDir, { recursive: true })
  await fsp.mkdir(outputDir, { recursive: true })
  await fsp.rm(assetPath, { force: true })
  await fsp.rm(`${assetPath}.sha256`, { force: true })

  const uvEnv = {
    ...process.env,
    UV_MANAGED_PYTHON: '1',
    UV_NO_PROGRESS: '1',
    UV_PYTHON_INSTALL_DIR: installationsDir
  }
  run(
    'uv',
    [
      'python',
      'install',
      MANAGED_PYTHON_VERSION,
      '--install-dir',
      installationsDir,
      '--no-bin',
      '--no-registry',
      '--managed-python'
    ],
    { env: uvEnv }
  )

  const pythonExecutable = run('uv', ['python', 'find', MANAGED_PYTHON_VERSION, '--managed-python'], {
    env: uvEnv,
    capture: true
  })
  const relativeExecutable = path.relative(installationsDir, pythonExecutable)
  if (!relativeExecutable || relativeExecutable.startsWith('..') || path.isAbsolute(relativeExecutable)) {
    throw new Error(`uv returned a Python executable outside the build directory: ${pythonExecutable}`)
  }

  const installationName = relativeExecutable.split(path.sep)[0]
  const installationDir = path.join(installationsDir, installationName)
  run(
    'uv',
    [
      'pip',
      'install',
      '--python',
      pythonExecutable,
      '--system',
      ...MANAGED_PYTHON_PACKAGES.map((entry) => entry.requirement)
    ],
    { env: uvEnv }
  )

  const probe = [
    'import importlib, json, sys',
    `packages = ${JSON.stringify(MANAGED_PYTHON_PACKAGES.map(({ id, importName }) => ({ id, importName })))}`,
    "[importlib.import_module(p['importName']) for p in packages]",
    "print(json.dumps({'version': '.'.join(map(str, sys.version_info[:3]))}))"
  ].join('; ')
  const probeResult = JSON.parse(
    run(pythonExecutable, ['-I', '-X', 'utf8', '-c', probe], {
      capture: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    })
  ) as { version: string }

  await fsp.mkdir(payloadDir, { recursive: true })
  await fsp.cp(installationDir, runtimeDir, { recursive: true, dereference: true, preserveTimestamps: false })
  const executableInRuntime = path.relative(installationDir, pythonExecutable).replaceAll(path.sep, '/')
  const copiedExecutable = path.join(runtimeDir, ...executableInRuntime.split('/'))
  if (platform !== 'win32') await fsp.chmod(copiedExecutable, 0o755)

  const metadata = await calculateRuntimeTreeMetadata(runtimeDir)
  const manifest = {
    format: MANAGED_PYTHON_RUNTIME_FORMAT,
    schemaVersion: MANAGED_PYTHON_RUNTIME_SCHEMA_VERSION,
    profileVersion: MANAGED_PYTHON_PROFILE_VERSION,
    pythonVersion: probeResult.version,
    platform,
    arch,
    executablePath: `runtime/${executableInRuntime}`,
    packages: MANAGED_PYTHON_PACKAGES.map((entry) => entry.id),
    ...metadata,
    createdAt: new Date().toISOString()
  }
  await fsp.writeFile(path.join(payloadDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await createZip(payloadDir, assetPath)

  const archiveHash = await calculateFileSha256(assetPath)
  await fsp.writeFile(`${assetPath}.sha256`, `${archiveHash}  ${assetName}\n`, 'utf8')
  process.stdout.write(`${assetPath}\n`)
} finally {
  await fsp.rm(workDir, { recursive: true, force: true })
}
