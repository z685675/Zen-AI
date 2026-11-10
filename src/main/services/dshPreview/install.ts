import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { getDataPath, getResourcePath, toAsarUnpackedPath } from '@main/utils'
import { DSH_PREVIEW_VERSION } from '@shared/dshPreview'
import { app, net } from 'electron'
import { x as extract } from 'tar'

const logger = loggerService.withContext('DshPreviewInstall')
const RESOURCE_FILES = ['package.json', 'package-lock.json', 'bootstrap.json', 'node.json', 'bridge.mjs']
export type DshInstallState = {
  version: string
  state: 'not-installed' | 'preparing' | 'ready' | 'error'
  progress?: string
  error?: string
}
let state: DshInstallState = { version: DSH_PREVIEW_VERSION, state: 'not-installed' }
let preparing: Promise<DshPreparedRuntime> | undefined
let preparationController: AbortController | undefined
let preparedRuntime: DshPreparedRuntime | undefined

export type DshPreparedRuntime = { runtimeRoot: string; entryPath: string; dataRoot: string; execPath: string }

export function dshResourceRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dsh-runtime')
    : toAsarUnpackedPath(path.join(getResourcePath(), 'dsh-runtime'))
}

export function dshDataRoot() {
  return getDataPath('DSHPreview')
}

export function buildDshEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|PROGRAMDATA|LANG|LC_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(
        key
      )
    )
      env[key] = value
  }
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: '1',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_DATA_HOME: path.join(home, 'data'),
    DSH_HOME: home,
    DSH_AGENTS_HOME: path.join(home, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    NO_UPDATE_NOTIFIER: '1'
  }
}

async function validRuntime(root: string) {
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(root, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')
    )
    return (
      manifest.version === DSH_PREVIEW_VERSION &&
      (await fs.stat(path.join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))).isFile()
    )
  } catch {
    return false
  }
}

export function getDshPreviewRuntimeStatus(): DshInstallState {
  return { ...state }
}

export function cancelDshPreviewPreparation() {
  preparationController?.abort(new Error('DSH preview preparation cancelled'))
  return (
    preparing?.then(
      () => undefined,
      () => undefined
    ) ?? Promise.resolve()
  )
}

export function getPreparedDshRuntime(): DshPreparedRuntime {
  if (state.state !== 'ready' || !preparedRuntime)
    throw new Error('Prepare the DeepSeek Harness preview in Settings before sending a message.')
  return preparedRuntime
}

export function prepareDshPreviewRuntime(signal?: AbortSignal): Promise<DshPreparedRuntime> {
  if (preparing) return preparing
  preparationController = new AbortController()
  const combined = signal ? AbortSignal.any([signal, preparationController.signal]) : preparationController.signal
  preparing = prepare(combined)
    .then((runtime) => {
      preparedRuntime = runtime
      return runtime
    })
    .catch((error) => {
      const phase = state.progress || 'preparing'
      const details = error as { code?: unknown; httpStatus?: unknown; exitCode?: unknown }
      state = {
        version: DSH_PREVIEW_VERSION,
        state: combined.aborted ? 'not-installed' : 'error',
        ...(combined.aborted ? {} : { progress: phase }),
        error: combined.aborted ? undefined : 'DSH runtime preparation failed. Check network access and retry.'
      }
      logger.warn('DSH preview preparation failed', {
        aborted: combined.aborted,
        phase,
        kind: error instanceof Error ? error.name : 'unknown',
        ...(typeof details?.code === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(details.code)
          ? { code: details.code }
          : {}),
        ...(typeof details?.httpStatus === 'number' ? { httpStatus: details.httpStatus } : {}),
        ...(typeof details?.exitCode === 'number' ? { exitCode: details.exitCode } : {})
      })
      throw error
    })
    .finally(() => {
      preparing = undefined
      preparationController = undefined
    })
  return preparing
}

async function prepare(signal: AbortSignal): Promise<DshPreparedRuntime> {
  signal.throwIfAborted()
  const resourceRoot = dshResourceRoot()
  const dataRoot = dshDataRoot()
  const runtimeRoot = path.join(dataRoot, `runtime-${DSH_PREVIEW_VERSION}`)
  const execPath = await prepareNode(resourceRoot, dataRoot, signal)
  const result = (root: string) => ({
    runtimeRoot: root,
    entryPath: path.join(resourceRoot, 'bridge.mjs'),
    dataRoot,
    execPath
  })
  if ((!app.isPackaged && (await validRuntime(resourceRoot))) || (await validRuntime(runtimeRoot))) {
    const existingRoot = !app.isPackaged && (await validRuntime(resourceRoot)) ? resourceRoot : runtimeRoot
    state = { version: DSH_PREVIEW_VERSION, state: 'preparing', progress: 'verifying' }
    await verifyNativeRuntime(execPath, path.join(resourceRoot, 'bridge.mjs'), existingRoot, dataRoot, signal)
    state = { version: DSH_PREVIEW_VERSION, state: 'ready' }
    return result(existingRoot)
  }
  state = { version: DSH_PREVIEW_VERSION, state: 'preparing', progress: 'downloading-installer' }
  const staging = path.join(dataRoot, `runtime-${DSH_PREVIEW_VERSION}.install`)
  // All removal targets are fixed children of our private application directory.
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })
  try {
    const bootstrap = JSON.parse(await fs.readFile(path.join(resourceRoot, 'bootstrap.json'), 'utf8')) as {
      url: string
      integrity: string
      version: string
    }
    if (!/^https:\/\/registry\.npmjs\.org\/npm\/-\/npm-[\d.]+\.tgz$/.test(bootstrap.url))
      throw new Error('Invalid npm bootstrap URL')
    const response = await net.fetch(bootstrap.url, { signal })
    if (!response.ok)
      throw Object.assign(new Error(`Installer download returned HTTP ${response.status}`), {
        code: 'dsh_installer_download_failed',
        httpStatus: response.status
      })
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('Installer exceeds the size limit')
    const expected = Buffer.from(bootstrap.integrity.replace(/^sha512-/, ''), 'base64')
    const digest = createHash('sha512').update(bytes).digest()
    if (
      !bootstrap.integrity.startsWith('sha512-') ||
      expected.length !== digest.length ||
      !timingSafeEqual(expected, digest)
    )
      throw Object.assign(new Error('Installer integrity mismatch'), { code: 'dsh_installer_integrity_mismatch' })
    const archive = path.join(staging, 'npm.tgz')
    const npmRoot = path.join(staging, 'installer')
    await fs.writeFile(archive, bytes)
    await fs.mkdir(npmRoot)
    await extract({
      file: archive,
      cwd: npmRoot,
      strip: 1,
      strict: true,
      preservePaths: false,
      filter: (name, entry) =>
        name.startsWith('package/') &&
        !name.split('/').includes('..') &&
        'type' in entry &&
        ['File', 'Directory', 'OldFile'].includes(entry.type)
    })
    const npmManifest = JSON.parse(await fs.readFile(path.join(npmRoot, 'package.json'), 'utf8'))
    if (npmManifest.version !== bootstrap.version) throw new Error('Installer version mismatch')
    for (const file of RESOURCE_FILES.slice(0, 2))
      await fs.copyFile(path.join(resourceRoot, file), path.join(staging, file))
    signal.throwIfAborted()
    state = { version: DSH_PREVIEW_VERSION, state: 'preparing', progress: 'installing-runtime' }
    await installDependencies(staging, path.join(npmRoot, 'bin/npm-cli.js'), execPath, signal)
    state = { version: DSH_PREVIEW_VERSION, state: 'preparing', progress: 'verifying' }
    if (!(await validRuntime(staging))) throw new Error('DSH runtime verification failed')
    await verifyNativeRuntime(execPath, path.join(resourceRoot, 'bridge.mjs'), staging, dataRoot, signal)
    signal.throwIfAborted()
    await fs.rm(npmRoot, { recursive: true, force: true })
    await fs.rm(archive, { force: true })
    await fs.rm(runtimeRoot, { recursive: true, force: true })
    await fs.rename(staging, runtimeRoot)
    state = { version: DSH_PREVIEW_VERSION, state: 'ready' }
    return result(runtimeRoot)
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function prepareNode(resourceRoot: string, dataRoot: string, signal: AbortSignal) {
  const metadata = JSON.parse(await fs.readFile(path.join(resourceRoot, 'node.json'), 'utf8')) as {
    version: string
    artifacts: Record<string, { file: string; sha256: string }>
  }
  const artifact = metadata.artifacts[`${process.platform}-${process.arch}`]
  if (!artifact) throw new Error('This platform is not supported by the DSH preview')
  const nodeRoot = path.join(dataRoot, `node-${metadata.version}-${process.platform}-${process.arch}`)
  const executable = path.join(nodeRoot, process.platform === 'win32' ? 'node.exe' : 'node')
  if (
    (await fs.readFile(path.join(nodeRoot, 'verified.sha256'), 'utf8').catch(() => '')) === artifact.sha256 &&
    (await fs.stat(executable).catch(() => undefined))?.isFile()
  )
    return executable
  state = { version: DSH_PREVIEW_VERSION, state: 'preparing', progress: 'downloading-node' }
  const staging = `${nodeRoot}.install`
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })
  try {
    if (!/^[\d.]+$/.test(metadata.version) || !/^[a-zA-Z0-9./-]+$/.test(artifact.file) || artifact.file.includes('..'))
      throw new Error('Invalid Node artifact metadata')
    const response = await net.fetch(`https://nodejs.org/dist/v${metadata.version}/${artifact.file}`, { signal })
    if (!response.ok)
      throw Object.assign(new Error(`Node download returned HTTP ${response.status}`), {
        code: 'dsh_node_download_failed',
        httpStatus: response.status
      })
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > 160 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      throw Object.assign(new Error('Official Node artifact integrity mismatch'), {
        code: 'dsh_node_integrity_mismatch'
      })
    if (process.platform === 'win32') await fs.writeFile(path.join(staging, 'node.exe'), bytes)
    else {
      const archive = path.join(staging, 'node.tgz')
      await fs.writeFile(archive, bytes)
      await extract({
        file: archive,
        cwd: staging,
        strip: 2,
        strict: true,
        preservePaths: false,
        filter: (name, entry) =>
          name === `${artifact.file.replace(/\.tar\.gz$/, '')}/bin/node` && 'type' in entry && entry.type === 'File'
      })
      await fs.chmod(path.join(staging, 'node'), 0o755)
      await fs.rm(archive)
    }
    signal.throwIfAborted()
    await fs.writeFile(path.join(staging, 'verified.sha256'), artifact.sha256)
    await fs.rm(nodeRoot, { recursive: true, force: true })
    await fs.rename(staging, nodeRoot)
    return executable
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function verifyNativeRuntime(
  executable: string,
  entry: string,
  runtimeRoot: string,
  dataRoot: string,
  signal: AbortSignal
) {
  const home = path.join(dataRoot, 'verification-home')
  await fs.mkdir(home, { recursive: true })
  try {
    await runPreparationChild(
      executable,
      [entry, runtimeRoot, '--verify'],
      home,
      buildDshEnvironment(home),
      signal,
      120000
    )
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function installDependencies(directory: string, npmCli: string, executable: string, signal: AbortSignal) {
  await runPreparationChild(
    executable,
    [
      npmCli,
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org/',
      '--cache',
      path.join(dshDataRoot(), 'npm-cache')
    ],
    directory,
    buildDshEnvironment(path.join(dshDataRoot(), 'installer-home')),
    signal,
    20 * 60000
  )
}

async function runPreparationChild(
  executable: string,
  args: string[],
  directory: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs: number
) {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: directory,
      env,
      windowsHide: true,
      stdio: 'ignore'
    })
    let timedOut = false
    const abort = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        killer.once('error', () => child.kill('SIGKILL'))
      } else child.kill('SIGKILL')
    }
    signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      abort()
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else if (timedOut)
        reject(Object.assign(new Error('DSH preparation exceeded the time limit'), { code: 'dsh_preparation_timeout' }))
      else if (code !== 0)
        reject(
          Object.assign(new Error(`DSH preparation child exited with code ${code}`), {
            code: args.includes('--verify') ? 'dsh_native_verification_failed' : 'dsh_installation_failed',
            exitCode: code
          })
        )
      else resolve()
    })
    if (signal.aborted) abort()
  })
}
