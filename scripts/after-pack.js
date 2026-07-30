const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { Arch } = require('electron-builder')

const CODEX_TARGETS = {
  'linux:arm64': { packageSuffix: 'linux-arm64', targetTriple: 'aarch64-unknown-linux-musl' },
  'linux:x64': { packageSuffix: 'linux-x64', targetTriple: 'x86_64-unknown-linux-musl' },
  'mac:arm64': { packageSuffix: 'darwin-arm64', targetTriple: 'aarch64-apple-darwin' },
  'mac:x64': { packageSuffix: 'darwin-x64', targetTriple: 'x86_64-apple-darwin' },
  'windows:arm64': { packageSuffix: 'win32-arm64', targetTriple: 'aarch64-pc-windows-msvc' },
  'windows:x64': { packageSuffix: 'win32-x64', targetTriple: 'x86_64-pc-windows-msvc' }
}

function findCodexVendorSource(target) {
  const rootDir = path.join(__dirname, '..')
  const packageName = `codex-${target.packageSuffix}`
  const directVendor = path.join(rootDir, 'node_modules', '@openai', packageName, 'vendor', target.targetTriple)
  if (fs.existsSync(directVendor)) {
    return directVendor
  }

  const pnpmDir = path.join(rootDir, 'node_modules', '.pnpm')
  if (!fs.existsSync(pnpmDir)) {
    return null
  }

  const suffix = `-${target.packageSuffix}`
  const candidates = fs
    .readdirSync(pnpmDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('@openai+codex@') && entry.name.endsWith(suffix))
    .map((entry) => path.join(pnpmDir, entry.name, 'node_modules', '@openai', 'codex', 'vendor', target.targetTriple))
    .filter((candidate) => fs.existsSync(candidate))

  return candidates.at(-1) ?? null
}

function copyCodexRuntime(context) {
  const platform = context.packager.platform.name
  const arch = context.arch === Arch.arm64 ? 'arm64' : 'x64'
  const target = CODEX_TARGETS[`${platform}:${arch}`]
  if (!target) {
    throw new Error(`[after-pack] unsupported Codex target: ${platform}/${arch}`)
  }

  const sourceDir = findCodexVendorSource(target)
  if (!sourceDir) {
    throw new Error(`[after-pack] Codex native package is missing for ${platform}/${arch}`)
  }

  const binaryName = platform === 'windows' ? 'codex.exe' : 'codex'
  const sourceBinary = path.join(sourceDir, 'bin', binaryName)
  const sourceManifest = path.join(sourceDir, 'codex-package.json')
  if (!fs.existsSync(sourceBinary) || !fs.existsSync(sourceManifest)) {
    throw new Error(`[after-pack] Codex native package is incomplete: ${sourceDir}`)
  }

  const destinationDir = path.join(context.appOutDir, 'resources', 'codex', 'vendor', target.targetTriple)
  fs.mkdirSync(path.dirname(destinationDir), { recursive: true })
  fs.cpSync(sourceDir, destinationDir, { recursive: true, force: true })
  console.log(`[after-pack] copied Codex runtime: ${destinationDir}`)
}

function findFilesRecursively(rootDir, fileName) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return []
  }

  const matches = []

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name)

    if (entry.isDirectory()) {
      matches.push(...findFilesRecursively(fullPath, fileName))
      continue
    }

    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      matches.push(fullPath)
    }
  }

  return matches
}

function findWindowsExecutable(appOutDir) {
  if (!fs.existsSync(appOutDir)) {
    return null
  }

  const executable = fs
    .readdirSync(appOutDir)
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .find((name) => !name.toLowerCase().startsWith('uninstall'))

  return executable ? path.join(appOutDir, executable) : null
}

function patchWindowsIcon(appOutDir) {
  const exePath = findWindowsExecutable(appOutDir)
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')
  const cacheRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign')
    : null

  if (!exePath || !fs.existsSync(iconPath)) {
    return
  }

  const rceditCandidates = findFilesRecursively(cacheRoot, 'rcedit-x64.exe').sort((left, right) => {
    return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs
  })

  if (rceditCandidates.length === 0) {
    console.warn('[after-pack] skipped icon patch because rcedit-x64.exe was not found in electron-builder cache')
    return
  }

  try {
    execFileSync(rceditCandidates[0], [exePath, '--set-icon', iconPath], { stdio: 'inherit' })
    console.log(`[after-pack] patched Windows executable icon: ${exePath}`)
  } catch (error) {
    console.warn(`[after-pack] failed to patch Windows executable icon: ${error.message}`)
  }
}

exports.default = async function (context) {
  const platform = context.packager.platform.name
  copyCodexRuntime(context)
  if (platform === 'windows') {
    fs.rmSync(path.join(context.appOutDir, 'LICENSE.electron.txt'), { force: true })
    fs.rmSync(path.join(context.appOutDir, 'LICENSES.chromium.html'), { force: true })
    patchWindowsIcon(context.appOutDir)
  }
}
