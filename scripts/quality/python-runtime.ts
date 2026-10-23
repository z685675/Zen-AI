import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import {
  MANAGED_PYTHON_PACKAGES,
  MANAGED_PYTHON_PROFILE_VERSION,
  MANAGED_PYTHON_VERSION
} from '../../src/main/services/python/ManagedPythonConfig'
import { execute, offlineEnvironment, redact, sanitizeEvidence } from './process'

export const QUALITY_PYTHON_MARKER = '.quality-python-cache.json'
const LEASE = '.quality-python-lease.json'

export function qualityPythonKey(platform = process.platform, arch = process.arch) {
  const digest = createHash('sha256')
    .update(JSON.stringify([MANAGED_PYTHON_VERSION, MANAGED_PYTHON_PROFILE_VERSION, MANAGED_PYTHON_PACKAGES]))
    .digest('hex')
    .slice(0, 16)
  return `${platform}-${arch}-p${MANAGED_PYTHON_PROFILE_VERSION}-${digest}`
}

export interface QualityPythonRuntime {
  cacheDir: string
  key: string
}

function inside(parent: string, target: string) {
  const relative = path.relative(parent, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('验收 Python 路径越出专用目录。')
}

async function plainDirectory(parent: string, name: string) {
  const target = path.join(parent, name)
  await mkdir(target, { recursive: true })
  const info = await lstat(target)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('验收 Python 目录不能是符号链接。')
  inside(await realpath(parent), await realpath(target))
  return await realpath(target)
}

export async function validateQualityPython(root: string, runtime: QualityPythonRuntime) {
  const local = await plainDirectory(await realpath(root), 'local')
  const caches = await plainDirectory(local, 'quality-runtimes')
  const key = qualityPythonKey()
  if (runtime.key !== key || path.resolve(runtime.cacheDir) !== path.join(caches, key))
    throw new Error('验收 Python 平台、依赖版本或缓存路径不匹配。')
  const cache = await plainDirectory(caches, key)
  const marker = path.join(cache, QUALITY_PYTHON_MARKER)
  const info = await lstat(marker)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('验收 Python 缓存标记无效。')
  const value = JSON.parse(await readFile(marker, 'utf8'))
  if (value.format !== 'zen-quality-python-v1' || value.key !== key) throw new Error('验收 Python 缓存标记不匹配。')
  await plainDirectory(cache, 'python')
  await plainDirectory(cache, 'tools')
  return cache
}

export async function acquireQualityPython(root: string) {
  const local = await plainDirectory(await realpath(root), 'local')
  const caches = await plainDirectory(local, 'quality-runtimes')
  const key = qualityPythonKey()
  const cacheDir = path.join(caches, key)
  let created = false
  try {
    await mkdir(cacheDir)
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (created)
    await writeFile(
      path.join(cacheDir, QUALITY_PYTHON_MARKER),
      JSON.stringify({ format: 'zen-quality-python-v1', key }),
      { flag: 'wx' }
    )
  const runtime = { cacheDir, key }
  await validateQualityPython(root, runtime)
  const token = randomUUID()
  const leasePath = path.join(cacheDir, LEASE)
  try {
    await writeFile(leasePath, JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() }), {
      flag: 'wx'
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `验收 Python 被另一批验收占用：${leasePath}。请先结束该批；若上次异常退出，确认相关进程已退出后再移除这个占用文件。不会自动抢占或修复正在使用的环境。`
      )
    throw error
  }
  return {
    ...runtime,
    async release() {
      const info = await lstat(leasePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
        throw new Error('验收 Python 占用文件发生变化，拒绝删除。')
      if (JSON.parse(await readFile(leasePath, 'utf8')).token !== token)
        throw new Error('验收 Python 占用身份不匹配，拒绝删除。')
      await unlink(leasePath)
    }
  }
}

/** Only the runtime is shared. userData, credentials, conversations and artifacts remain per-run. */
export async function mountQualityPython(root: string, instance: string, runtime: QualityPythonRuntime) {
  const cache = await validateQualityPython(root, runtime)
  const data = await plainDirectory(await realpath(instance), 'userData')
  const runtimes = await plainDirectory(data, 'runtimes')
  const target = path.join(runtimes, 'python')
  // Never replace an existing path, including an unrelated environment or dangling junction.
  await symlink(path.join(cache, 'python'), target, process.platform === 'win32' ? 'junction' : 'dir')
  if ((await realpath(target)) !== (await realpath(path.join(cache, 'python'))))
    throw new Error('验收 Python 挂载校验失败。')
}

export async function prepareQualityPython(
  root: string,
  directory: string,
  signal?: AbortSignal,
  dependencies: { execute?: typeof execute } = {}
) {
  const started = performance.now()
  const evidence = path.join(directory, 'python-environment.json')
  await mkdir(directory, { recursive: true })
  let lease: Awaited<ReturnType<typeof acquireQualityPython>>
  try {
    lease = await acquireQualityPython(root)
  } catch (error) {
    await writeFile(evidence, JSON.stringify({ ready: false, detail: redact(String(error)) }, null, 2))
    throw error
  }
  let terminationUnconfirmed = false
  try {
    if (signal?.aborted) throw new Error('已取消，未准备验收 Python。')
    const setup = path.join(directory, 'python-preflight')
    await mkdir(setup, { recursive: true })
    const request = path.join(setup, 'request.json')
    await writeFile(request, JSON.stringify({ root: await realpath(root), cacheDir: lease.cacheDir, key: lease.key }))
    const env = offlineEnvironment(process.env)
    for (const key of [
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'XDG_DATA_HOME',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'TEMP',
      'TMP',
      'TMPDIR'
    ]) {
      env[key] = path.join(setup, 'instance', key)
      await mkdir(env[key], { recursive: true })
    }
    // Installers write only to this dedicated tool home, never the user's ~/.zen-ai.
    env.HOME = env.USERPROFILE = path.join(lease.cacheDir, 'tools')
    env.NODE_ENV = 'test'
    env.ZEN_QUALITY_PYTHON_REQUEST = request
    delete env.QUALITY_OFFLINE
    delete env.npm_config_offline
    const require = createRequire(path.join(root, 'package.json'))
    const heartbeat = setInterval(() => {
      process.stdout.write(
        `[LIVE-PYTHON] 免费环境准备仍在进行，已用时${Math.round((performance.now() - started) / 1000)}秒；尚未开始模型请求。\n`
      )
    }, 15000)
    let result: Awaited<ReturnType<typeof execute>>
    try {
      result = await (dependencies.execute ?? execute)(
        { file: require('electron') as string, args: [path.join(root, 'scripts/quality/python-entry.cjs')], cwd: root },
        { env, timeoutMs: 30 * 60 * 1000, signal, maxOutputBytes: 4 * 1024 * 1024 }
      )
    } finally {
      clearInterval(heartbeat)
    }
    terminationUnconfirmed = result.terminationUnconfirmed
    await writeFile(path.join(directory, 'python-environment.log'), redact(result.stdout + '\n' + result.stderr))
    if (
      result.exitCode !== 0 ||
      result.signal ||
      result.timedOut ||
      result.cancelled ||
      result.error ||
      result.outputTruncated ||
      result.terminationUnconfirmed
    )
      throw new Error(
        `验收 Python 准备未正常完成（exit=${result.exitCode}，取消=${result.cancelled}，超时=${result.timedOut}，进程终止未确认=${result.terminationUnconfirmed}）。详情见 python-environment.log；未发送模型请求。`
      )
    const proof = JSON.parse(await readFile(path.join(setup, 'result.json'), 'utf8'))
    if (
      proof.key !== lease.key ||
      proof.ready !== true ||
      proof.sum !== 89 ||
      proof.xlsxRoundTrip !== true ||
      !String(proof.pythonVersion).startsWith(`${MANAGED_PYTHON_VERSION}.`) ||
      proof.bits !== 64 ||
      proof.packages?.length !== MANAGED_PYTHON_PACKAGES.length ||
      MANAGED_PYTHON_PACKAGES.some(({ id }) => !proof.packages.includes(id) || typeof proof.versions?.[id] !== 'string')
    )
      throw new Error('验收 Python 缺少真实依赖导入、计算和文件读写证据。')
    inside(await realpath(path.join(lease.cacheDir, 'python')), await realpath(proof.executablePath))
    await writeFile(
      evidence,
      JSON.stringify(sanitizeEvidence({ ...proof, durationMs: performance.now() - started }), null, 2)
    )
    return lease
  } catch (error) {
    const detail = redact(String(error))
    await writeFile(evidence, JSON.stringify({ ready: false, key: lease.key, detail, terminationUnconfirmed }, null, 2))
    if (!terminationUnconfirmed) await lease.release()
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const root = path.resolve(__dirname, '../..')
  const directory = path.join(root, 'local/quality-reports', `python-${Date.now()}-${randomUUID().slice(0, 8)}`)
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  process.stdout.write(`免费验收环境预检，不调用模型。首次可能下载运行时及依赖。\n报告目录：${directory}\n`)
  prepareQualityPython(root, directory, controller.signal)
    .then(async (runtime) => {
      await runtime.release()
      process.stdout.write('验收 Zen Python 已就绪：依赖、计算及 JSON/Excel 文件读写验证通过。\n')
    })
    .catch((error) => {
      process.stderr.write(redact(String(error)) + '\n')
      process.exitCode = controller.signal.aborted ? 130 : 1
    })
    .finally(() => {
      process.off('SIGINT', cancel)
      process.off('SIGTERM', cancel)
    })
}
