import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { MANAGED_PYTHON_PACKAGES, MANAGED_PYTHON_VERSION } from '../../src/main/services/python/ManagedPythonConfig'
import { ManagedPythonService } from '../../src/main/services/python/ManagedPythonService'
import { runInstallScript } from '../../src/main/utils/process'
import { type QualityPythonRuntime, validateQualityPython } from './python-runtime'

/** Runs in the headless Electron child with no models or API credentials configured. */
export async function prepareInElectron(request: QualityPythonRuntime & { root: string }, setup: string) {
  const cache = await validateQualityPython(request.root, request)
  const runtimeDir = path.join(cache, 'python')
  const toolsHome = path.join(cache, 'tools')
  if (process.env.HOME !== toolsHome || process.env.USERPROFILE !== toolsHome)
    throw new Error('验收安装器的工具目录未隔离。')
  const resolveUvPath = async () => {
    const uv = path.join(toolsHome, '.zen-ai/bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
    if (!(await lstat(uv).catch(() => null))?.isFile()) {
      // Keep installer descendants in this process tree for outer cancellation/timeout.
      await runInstallScript('install-uv.js')
    }
    return uv
  }
  const service = new ManagedPythonService({ rootDir: runtimeDir, resolveUvPath })
  const before = await service.getStatus()
  const status = await service.ensureReady()
  if (
    !status.ready ||
    !(status.version === MANAGED_PYTHON_VERSION || status.version?.startsWith(`${MANAGED_PYTHON_VERSION}.`))
  )
    throw new Error('验收 Python 版本或依赖不符合当前软件要求。')
  const workspace = path.join(setup, 'workspace')
  await mkdir(workspace, { recursive: true })
  const source = JSON.stringify({ amounts: [17, 29, 43], note: '验收环境免费预检' })
  await writeFile(path.join(workspace, 'probe-input.json'), source, { flag: 'wx' })
  const result = await service.execute(
    [
      'import importlib, importlib.metadata, json, pathlib, platform, struct, sys',
      `packages = ${JSON.stringify(MANAGED_PYTHON_PACKAGES.map(({ id, importName }) => ({ id, importName })))}`,
      "[importlib.import_module(p['importName']) for p in packages]",
      "source = pathlib.Path('probe-input.json')",
      "total = sum(json.loads(source.read_text(encoding='utf-8'))['amounts'])",
      'import openpyxl',
      'book = openpyxl.Workbook()',
      'book.active.cell(1, 1, total)',
      "book.save('probe.xlsx')",
      "loaded = openpyxl.load_workbook('probe.xlsx')",
      'round_trip = loaded.active.cell(1, 1).value == total',
      'loaded.close()',
      "proof = {'sum': total, 'xlsxRoundTrip': round_trip, 'packages': [p['id'] for p in packages], 'versions': {p['id']: importlib.metadata.version(p['id']) for p in packages}, 'pythonVersion': platform.python_version(), 'machine': platform.machine(), 'bits': struct.calcsize('P') * 8}",
      "pathlib.Path('probe-output.json').write_text(json.dumps(proof), encoding='utf-8')",
      'print(json.dumps(proof))'
    ].join('\n'),
    { cwd: workspace, timeoutMs: 120000 }
  )
  if (result.exitCode !== 0) throw new Error(`验收 Python 实际执行失败：${result.stderr}`)
  const proof = JSON.parse(await readFile(path.join(workspace, 'probe-output.json'), 'utf8'))
  if (
    proof.sum !== 89 ||
    proof.xlsxRoundTrip !== true ||
    (await readFile(path.join(workspace, 'probe-input.json'), 'utf8')) !== source
  )
    throw new Error('验收 Python 计算、文件读写或原件保护验证失败。')
  await writeFile(
    path.join(setup, 'result.json'),
    JSON.stringify(
      {
        ...proof,
        key: request.key,
        ready: true,
        reused: before.ready,
        executablePath: await realpath(status.executablePath),
        source: status.source
      },
      null,
      2
    ),
    { flag: 'wx' }
  )
}
