const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { createRequire } = require('node:module')
const { Arch } = require('electron-builder')
const { AGENT_TARGETS, getPackagedAgentPaths, verifyPackagedAgentRuntimes } = require('./agent-runtime-packaging')
const { copyOpenCodeRuntime, copyOpenCodeOfflineRuntime } = require('./opencode-runtime-packaging')
const { prepareMacBundleLinks } = require('./mac-bundle-links')

function findCodexVendorSource(target, rootDir) {
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

function findClaudeNativeSource(target, rootDir) {
  const packageName = `@anthropic-ai/claude-agent-sdk-${target.packageSuffix}`
  const binaryName = target.packageSuffix.startsWith('win32-') ? 'claude.exe' : 'claude'
  const directDir = path.join(rootDir, 'node_modules', ...packageName.split('/'))
  if (fs.existsSync(path.join(directDir, binaryName))) return directDir

  try {
    const projectRequire = createRequire(path.join(rootDir, 'package.json'))
    const sdkRequire = createRequire(projectRequire.resolve('@anthropic-ai/claude-agent-sdk'))
    return path.dirname(sdkRequire.resolve(`${packageName}/${binaryName}`))
  } catch {
    // pnpm may keep target-platform optional packages only in its virtual store.
  }
  const pnpmDir = path.join(rootDir, 'node_modules', '.pnpm')
  if (!fs.existsSync(pnpmDir)) return null
  const candidates = fs
    .readdirSync(pnpmDir)
    .filter((entry) => entry.startsWith(`${packageName.replace('/', '+')}@`))
    .map((entry) => path.join(pnpmDir, entry, 'node_modules', ...packageName.split('/')))
    .filter((dir) => fs.existsSync(path.join(dir, binaryName)))
  return candidates.at(-1) ?? null
}

function copyAgentRuntimes(context, rootDir = path.join(__dirname, '..')) {
  const platform = context.packager.platform.name
  const arch = context.arch === Arch.arm64 ? 'arm64' : 'x64'
  const target = AGENT_TARGETS[`${platform}:${arch}`]
  if (!target) {
    throw new Error(`[after-pack] unsupported Codex target: ${platform}/${arch}`)
  }

  const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
  const paths = getPackagedAgentPaths(resourcesDir, platform, arch)
  const sourceDir = findCodexVendorSource(target, rootDir)
  if (!sourceDir) {
    throw new Error(`[after-pack] Codex native package is missing for ${platform}/${arch}`)
  }

  const binaryName = platform === 'windows' ? 'codex.exe' : 'codex'
  const sourceBinary = path.join(sourceDir, 'bin', binaryName)
  const sourceManifest = path.join(sourceDir, 'codex-package.json')
  if (!fs.existsSync(sourceBinary) || !fs.existsSync(sourceManifest)) {
    throw new Error(`[after-pack] Codex native package is incomplete: ${sourceDir}`)
  }

  const destinationDir = paths.codexDir
  fs.mkdirSync(path.dirname(destinationDir), { recursive: true })
  fs.cpSync(sourceDir, destinationDir, { recursive: true, force: true, dereference: true })
  console.log(`[after-pack] copied Codex runtime: ${destinationDir}`)

  const claudeSource = findClaudeNativeSource(target, rootDir)
  if (!claudeSource) throw new Error(`[after-pack] Claude Code native package is missing for ${platform}/${arch}`)
  fs.mkdirSync(path.dirname(paths.claudeDir), { recursive: true })
  fs.cpSync(claudeSource, paths.claudeDir, { recursive: true, force: true, dereference: true })
  if (platform !== 'windows') {
    fs.chmodSync(paths.codexBinary, 0o755)
    fs.chmodSync(paths.claudeBinary, 0o755)
  }
  verifyPackagedAgentRuntimes(resourcesDir, platform, arch)
  console.log(`[after-pack] copied and verified Claude Code runtime: ${paths.claudeDir}`)
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
  copyAgentRuntimes(context)
  copyOpenCodeRuntime(context)
  copyOpenCodeOfflineRuntime(context)
  if (platform === 'mac') {
    const links = prepareMacBundleLinks(context.packager.getResourcesDir(context.appOutDir), path.join(__dirname, '..'))
    console.log(`[after-pack] verified Mac bundle links; materialized ${links.length} resource links`)
    for (const link of links) console.log(`[after-pack] materialized: ${link}`)
  }
  if (platform === 'windows') {
    fs.rmSync(path.join(context.appOutDir, 'LICENSE.electron.txt'), { force: true })
    fs.rmSync(path.join(context.appOutDir, 'LICENSES.chromium.html'), { force: true })
    patchWindowsIcon(context.appOutDir)
  }
}

exports.copyAgentRuntimes = copyAgentRuntimes
