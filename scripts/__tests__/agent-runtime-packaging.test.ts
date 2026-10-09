import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { Arch } from 'electron-builder'
import { afterEach, describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const { copyAgentRuntimes } = require_('../after-pack.js')
const { AGENT_TARGETS, getPackagedAgentPaths, verifyNativeAgentBinary, verifyPackagedAgentRuntimes } = require_(
  '../agent-runtime-packaging.js'
)
const tempDirs: string[] = []

function makeFixture(platform: 'mac' | 'windows', arch: 'arm64' | 'x64', pnpmClaude = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-ai-runtime-test-'))
  tempDirs.push(root)
  const header = Buffer.alloc(256)
  if (platform === 'mac') {
    header.writeUInt32LE(0xfeedfacf, 0)
    header.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  } else {
    header.write('MZ', 0)
    header.writeUInt32LE(128, 60)
    header.writeUInt32LE(0x00004550, 128)
    header.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 132)
  }
  const target = AGENT_TARGETS[`${platform}:${arch}`]
  const codexDir = path.join(
    root,
    'node_modules',
    '@openai',
    `codex-${target.packageSuffix}`,
    'vendor',
    target.targetTriple
  )
  fs.mkdirSync(path.join(codexDir, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(codexDir, 'bin', platform === 'windows' ? 'codex.exe' : 'codex'), header)
  fs.writeFileSync(path.join(codexDir, 'codex-package.json'), '{}')
  const claudePackage = `claude-agent-sdk-${target.packageSuffix}`
  const claudeDir = pnpmClaude
    ? path.join(
        root,
        'node_modules',
        '.pnpm',
        `@anthropic-ai+${claudePackage}@0.3.273`,
        'node_modules',
        '@anthropic-ai',
        claudePackage
      )
    : path.join(root, 'node_modules', '@anthropic-ai', claudePackage)
  fs.mkdirSync(claudeDir, { recursive: true })
  const claudeBinary = path.join(claudeDir, platform === 'windows' ? 'claude.exe' : 'claude')
  fs.writeFileSync(claudeBinary, header)
  const outDir = path.join(root, 'dist')
  const resources =
    platform === 'mac' ? path.join(outDir, 'Zen AI.app', 'Contents', 'Resources') : path.join(outDir, 'resources')
  const context = {
    appOutDir: outDir,
    arch: arch === 'arm64' ? Arch.arm64 : Arch.x64,
    packager: { platform: { name: platform }, getResourcesDir: () => resources }
  }
  return { root, context, resources, claudeBinary, header }
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('zen-ai-runtime-test-'))
      throw new Error('Unexpected test directory')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('packaged agent runtimes', () => {
  it.each(['arm64', 'x64'] as const)('puts both Mac %s binaries inside the application bundle', (arch) => {
    const fixture = makeFixture('mac', arch, true)
    copyAgentRuntimes(fixture.context, fixture.root)
    const paths = verifyPackagedAgentRuntimes(fixture.resources, 'mac', arch)
    expect(fs.readFileSync(paths.claudeBinary)).toEqual(fixture.header)
    expect(fs.existsSync(path.join(fixture.context.appOutDir, 'resources'))).toBe(false)
  })

  it.each(['arm64', 'x64'] as const)('keeps both Windows %s binaries in the executable resource directory', (arch) => {
    const fixture = makeFixture('windows', arch)
    copyAgentRuntimes(fixture.context, fixture.root)
    const paths = verifyPackagedAgentRuntimes(fixture.resources, 'windows', arch)
    expect(paths.claudeBinary.endsWith('claude.exe')).toBe(true)
    expect(paths.codexBinary.endsWith('codex.exe')).toBe(true)
  })

  it('stops packaging when the optional Claude native dependency is absent', () => {
    const fixture = makeFixture('mac', 'arm64')
    fs.unlinkSync(fixture.claudeBinary)
    expect(() => copyAgentRuntimes(fixture.context, fixture.root)).toThrow('Claude Code native package is missing')
  })

  it('copies real files rather than a dependency link pointing back to the build machine', () => {
    const fixture = makeFixture('windows', 'x64')
    const sourceDir = path.dirname(fixture.claudeBinary)
    const realDir = path.join(fixture.root, 'native-package')
    fs.renameSync(sourceDir, realDir)
    fs.symlinkSync(realDir, sourceDir, process.platform === 'win32' ? 'junction' : 'dir')
    copyAgentRuntimes(fixture.context, fixture.root)
    const paths = getPackagedAgentPaths(fixture.resources, 'windows', 'x64')
    expect(fs.lstatSync(paths.claudeDir).isSymbolicLink()).toBe(false)
    expect(fs.lstatSync(paths.claudeBinary).isFile()).toBe(true)
  })

  it.each(['mac', 'windows'] as const)('rejects an x64 binary in a %s ARM64 installer', (platform) => {
    const fixture = makeFixture(platform, 'arm64')
    const x64 = makeFixture(platform, 'x64')
    fs.writeFileSync(fixture.claudeBinary, x64.header)
    expect(() => copyAgentRuntimes(fixture.context, fixture.root)).toThrow(`does not match ${platform}/arm64`)
  })

  it('detects a missing Claude binary in a completed package', () => {
    const fixture = makeFixture('mac', 'arm64')
    copyAgentRuntimes(fixture.context, fixture.root)
    const paths = getPackagedAgentPaths(fixture.resources, 'mac', 'arm64')
    fs.unlinkSync(paths.claudeBinary)
    expect(() => verifyPackagedAgentRuntimes(fixture.resources, 'mac', 'arm64')).toThrow()
  })

  it('rejects truncated native executables', () => {
    const fixture = makeFixture('windows', 'x64')
    fs.writeFileSync(fixture.claudeBinary, 'MZ')
    expect(() => verifyNativeAgentBinary(fixture.claudeBinary, 'windows', 'x64')).toThrow('incomplete')
  })
})
