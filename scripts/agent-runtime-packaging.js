const fs = require('node:fs')
const path = require('node:path')

const AGENT_TARGETS = {
  'linux:arm64': { packageSuffix: 'linux-arm64', targetTriple: 'aarch64-unknown-linux-musl' },
  'linux:x64': { packageSuffix: 'linux-x64', targetTriple: 'x86_64-unknown-linux-musl' },
  'mac:arm64': { packageSuffix: 'darwin-arm64', targetTriple: 'aarch64-apple-darwin' },
  'mac:x64': { packageSuffix: 'darwin-x64', targetTriple: 'x86_64-apple-darwin' },
  'windows:arm64': { packageSuffix: 'win32-arm64', targetTriple: 'aarch64-pc-windows-msvc' },
  'windows:x64': { packageSuffix: 'win32-x64', targetTriple: 'x86_64-pc-windows-msvc' }
}

function getPackagedAgentPaths(resourcesDir, platform, arch) {
  const target = AGENT_TARGETS[`${platform}:${arch}`]
  if (!target) throw new Error(`Unsupported agent runtime target: ${platform}/${arch}`)
  const codexDir = path.join(resourcesDir, 'codex', 'vendor', target.targetTriple)
  const claudeDir = path.join(resourcesDir, 'claude-code', target.packageSuffix)
  return {
    codexDir,
    claudeDir,
    codexBinary: path.join(codexDir, 'bin', platform === 'windows' ? 'codex.exe' : 'codex'),
    codexManifest: path.join(codexDir, 'codex-package.json'),
    claudeBinary: path.join(claudeDir, platform === 'windows' ? 'claude.exe' : 'claude')
  }
}

function verifyNativeAgentBinary(binaryPath, platform, arch) {
  const fd = fs.openSync(binaryPath, 'r')
  const header = Buffer.alloc(64)
  let machine
  try {
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0)
    if (bytesRead < header.length) throw new Error(`Agent executable is incomplete: ${binaryPath}`)
    if (platform === 'mac' && header.readUInt32LE(0) === 0xfeedfacf) {
      machine = header.readUInt32LE(4)
    } else if (platform === 'linux' && header.toString('hex', 0, 4) === '7f454c46') {
      machine = header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18)
    } else if (platform === 'windows' && header.toString('ascii', 0, 2) === 'MZ') {
      const peHeader = Buffer.alloc(6)
      if (fs.readSync(fd, peHeader, 0, peHeader.length, header.readUInt32LE(60)) === peHeader.length) {
        if (peHeader.readUInt32LE(0) === 0x00004550) machine = peHeader.readUInt16LE(4)
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  const machines = {
    mac: { arm64: 0x0100000c, x64: 0x01000007 },
    linux: { arm64: 183, x64: 62 },
    windows: { arm64: 0xaa64, x64: 0x8664 }
  }
  if (machine == null || machine !== machines[platform]?.[arch]) {
    throw new Error(`Agent executable does not match ${platform}/${arch}: ${binaryPath}`)
  }
  if (process.platform !== 'win32' && platform !== 'windows' && (fs.statSync(binaryPath).mode & 0o111) === 0) {
    throw new Error(`Agent executable has no execute permission: ${binaryPath}`)
  }
}

function verifyPackagedAgentRuntimes(resourcesDir, platform, arch) {
  const paths = getPackagedAgentPaths(resourcesDir, platform, arch)
  if (!fs.statSync(paths.codexManifest).isFile()) throw new Error(`Missing Codex manifest: ${paths.codexManifest}`)
  verifyNativeAgentBinary(paths.codexBinary, platform, arch)
  verifyNativeAgentBinary(paths.claudeBinary, platform, arch)
  return paths
}

module.exports = { AGENT_TARGETS, getPackagedAgentPaths, verifyNativeAgentBinary, verifyPackagedAgentRuntimes }
