const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { Arch } = require('electron-builder')
const { verifyNativeAgentBinary } = require('./agent-runtime-packaging')

const VERSION = '1.19.4'

function copyOpenCodeRuntime(context, rootDir = path.join(__dirname, '..')) {
  const platform = context.packager.platform.name
  const os = { mac: 'darwin', windows: 'windows', linux: 'linux' }[platform]
  const arch = context.arch === Arch.arm64 ? 'arm64' : 'x64'
  if (!os) throw new Error(`Unsupported OpenCode packaging target: ${platform}`)
  const packageName = `opencode-${os}-${arch}${arch === 'x64' ? '-baseline' : ''}`
  let source
  try {
    const projectRequire = createRequire(path.join(rootDir, 'package.json'))
    const wrapperRequire = createRequire(projectRequire.resolve('opencode-ai/package.json'))
    source = path.dirname(wrapperRequire.resolve(`${packageName}/package.json`))
  } catch {
    const pnpm = path.join(rootDir, 'node_modules', '.pnpm', `${packageName}@${VERSION}`, 'node_modules', packageName)
    source = fs.existsSync(pnpm) ? pnpm : path.join(rootDir, 'node_modules', packageName)
  }
  if (!fs.existsSync(path.join(source, 'package.json')))
    throw new Error(`OpenCode native package missing: ${packageName}`)
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
  if (manifest.version !== VERSION) throw new Error('Unexpected OpenCode native package version')
  const name = platform === 'windows' ? 'opencode.exe' : 'opencode'
  const destination = path.join(context.packager.getResourcesDir(context.appOutDir), 'opencode', `${os}-${arch}`, name)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(path.join(source, 'bin', name), destination)
  if (platform !== 'windows') fs.chmodSync(destination, 0o755)
  verifyNativeAgentBinary(destination, platform, arch)
  return destination
}

function generateOpenCodeLicenses(rootDir = path.join(__dirname, '..')) {
  const modules = path.join(rootDir, 'resources', 'opencode-runtime', 'node_modules')
  const packages = fs
    .readdirSync(modules, { withFileTypes: true })
    .flatMap((entry) =>
      entry.name.startsWith('@')
        ? fs.readdirSync(path.join(modules, entry.name)).map((name) => path.join(modules, entry.name, name))
        : [path.join(modules, entry.name)]
    )
  const notices = ['OpenCode offline plugin dependencies / 第三方依赖声明\n']
  for (const directory of packages.sort()) {
    const manifestPath = path.join(directory, 'package.json')
    if (!fs.existsSync(manifestPath)) continue
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const licenses = fs.readdirSync(directory).filter((name) => /^licen[sc]e|^notice/i.test(name))
    notices.push(`${manifest.name}@${manifest.version}\nLicense: ${manifest.license || 'See OpenCode MIT license'}\n`)
    for (const file of licenses)
      if (fs.statSync(path.join(directory, file)).isFile())
        notices.push(fs.readFileSync(path.join(directory, file), 'utf8'))
  }
  const target = path.join(rootDir, 'resources', 'licenses', 'opencode-dependencies.txt')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, notices.join('\n\n----------------------------------------\n\n').replace(/[ \t]+$/gm, ''))
}

function copyOpenCodeOfflineRuntime(context, rootDir = path.join(__dirname, '..')) {
  const resources = context.packager.getResourcesDir(context.appOutDir)
  const bundle = path.join(rootDir, 'resources', 'opencode-runtime')
  const destination = path.join(resources, 'opencode-runtime')
  for (const required of ['package.json', 'package-lock.json', 'node_modules/@opencode-ai/plugin/package.json']) {
    if (!fs.existsSync(path.join(bundle, required))) throw new Error(`OpenCode offline resource missing: ${required}`)
  }
  // electron-builder's dependency collector drops npm lockfiles even under
  // resources. Copy the complete real tree outside ASAR without that filter.
  fs.cpSync(bundle, destination, { recursive: true, dereference: true })
  const licenses = path.join(resources, 'licenses')
  fs.mkdirSync(licenses, { recursive: true })
  for (const name of ['opencode-LICENSE.txt', 'opencode-dependencies.txt'])
    fs.copyFileSync(path.join(rootDir, 'resources', 'licenses', name), path.join(licenses, name))
}

module.exports = { copyOpenCodeRuntime, copyOpenCodeOfflineRuntime, generateOpenCodeLicenses }
