const fs = require('node:fs')
const path = require('node:path')
const { Arch } = require('electron-builder')
const { AGENT_TARGETS, verifyNativeAgentBinary } = require('./agent-runtime-packaging')

function copySearchBinary(context, root = path.join(__dirname, '..')) {
  const platform = context.packager.platform.name
  const arch = context.arch === Arch.arm64 ? 'arm64' : 'x64'
  const target = AGENT_TARGETS[`${platform}:${arch}`]
  if (!target) throw new Error(`Unsupported search binary target: ${platform}/${arch}`)
  const name = platform === 'windows' ? 'rg.exe' : 'rg'
  const direct = path.join(
    root,
    'node_modules',
    '@openai',
    `codex-${target.packageSuffix}`,
    'vendor',
    target.targetTriple
  )
  const store = path.join(root, 'node_modules', '.pnpm')
  const candidates = fs.existsSync(store)
    ? fs
        .readdirSync(store, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.startsWith('@openai+codex@') &&
            entry.name.endsWith(`-${target.packageSuffix}`)
        )
        .map((entry) => path.join(store, entry.name, 'node_modules', '@openai', 'codex', 'vendor', target.targetTriple))
    : []
  const source = [direct, ...candidates].map((dir) => path.join(dir, 'codex-path', name)).find(fs.existsSync)
  if (!source) throw new Error(`Standalone ripgrep is missing for ${platform}/${arch}`)
  const resources = context.packager.getResourcesDir(context.appOutDir)
  const destination = path.join(resources, 'search', name)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
  const license = path.join(root, 'resources', 'licenses', 'ripgrep-LICENSE.txt')
  if (!fs.existsSync(license)) throw new Error('ripgrep license is missing')
  fs.mkdirSync(path.join(resources, 'licenses'), { recursive: true })
  fs.copyFileSync(license, path.join(resources, 'licenses', 'ripgrep-LICENSE.txt'))
  if (platform !== 'windows') fs.chmodSync(destination, 0o755)
  verifyNativeAgentBinary(destination, platform, arch)
  return destination
}

module.exports = { copySearchBinary }
