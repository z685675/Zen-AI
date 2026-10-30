const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { verifyNativeAgentBinary } = require('./agent-runtime-packaging')

const [resourcesDir, platform, arch] = process.argv.slice(2)
if (!resourcesDir || !platform || !arch || process.argv.length !== 5) {
  throw new Error('Usage: check-packaged-agent-runtimes.js <resources-directory> <mac|windows|linux> <arm64|x64>')
}
const opencodeOS = { mac: 'darwin', windows: 'windows', linux: 'linux' }[platform]
if (!opencodeOS || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported platform or architecture')
for (const legacy of ['codex', 'claude-code']) {
  if (fs.existsSync(path.join(resourcesDir, legacy))) throw new Error(`Unexpected legacy runtime: ${legacy}`)
}
const opencodeBinary = path.join(
  path.resolve(resourcesDir),
  'opencode',
  `${opencodeOS}-${arch}`,
  platform === 'windows' ? 'opencode.exe' : 'opencode'
)
verifyNativeAgentBinary(opencodeBinary, platform, arch)
const searchBinary = path.join(path.resolve(resourcesDir), 'search', platform === 'windows' ? 'rg.exe' : 'rg')
verifyNativeAgentBinary(searchBinary, platform, arch)
for (const required of [
  'opencode-runtime/package.json',
  'opencode-runtime/package-lock.json',
  'opencode-runtime/node_modules/@opencode-ai/plugin/package.json',
  'licenses/opencode-LICENSE.txt',
  'licenses/opencode-dependencies.txt',
  'licenses/ripgrep-LICENSE.txt'
]) {
  if (!fs.existsSync(path.join(resourcesDir, required)))
    throw new Error(`Missing OpenCode installer resource: ${required}`)
}
const hostPlatform = { darwin: 'mac', win32: 'windows', linux: 'linux' }[process.platform]
if (platform === hostPlatform && arch === process.arch) {
  for (const [name, binary] of [
    ['OpenCode', opencodeBinary],
    ['ripgrep', searchBinary]
  ]) {
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      env: { ...process.env, CI: 'true' }
    })
    if (result.error || result.status !== 0 || !result.stdout.trim()) {
      throw new Error(`${name} cannot start in packaged ${platform}/${arch}: ${result.error?.message ?? result.stderr}`)
    }
    console.log(`[agent-runtimes] ${name}: ${result.stdout.trim()}`)
  }
} else {
  console.log(`[agent-runtimes] ${platform}/${arch}: cross-architecture binaries verified without executing them`)
}
console.log(`[agent-runtimes] Verified OpenCode and standalone search for ${platform}/${arch}.`)
