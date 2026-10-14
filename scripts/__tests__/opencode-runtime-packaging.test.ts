import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { Arch } from 'electron-builder'
import { afterEach, describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const { copyOpenCodeRuntime, copyOpenCodeOfflineRuntime } = require_('../opencode-runtime-packaging')
const fixtures: string[] = []
function fixture(platform: 'mac' | 'windows', arch: 'arm64' | 'x64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-opencode-pack-test-'))
  fixtures.push(root)
  const osName = platform === 'mac' ? 'darwin' : 'windows'
  const pkg = `opencode-${osName}-${arch}${arch === 'x64' ? '-baseline' : ''}`
  const source = path.join(root, 'node_modules', pkg)
  fs.mkdirSync(path.join(source, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: pkg, version: '1.18.35' }))
  const bytes = Buffer.alloc(256)
  if (platform === 'mac') {
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
  } else {
    bytes.write('MZ')
    bytes.writeUInt32LE(128, 60)
    bytes.writeUInt32LE(0x00004550, 128)
    bytes.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 132)
  }
  const binary = path.join(source, 'bin', platform === 'mac' ? 'opencode' : 'opencode.exe')
  fs.writeFileSync(binary, bytes)
  const resources = path.join(root, 'dist', 'resources')
  return {
    root,
    binary,
    context: {
      arch: arch === 'arm64' ? Arch.arm64 : Arch.x64,
      appOutDir: path.join(root, 'dist'),
      packager: { platform: { name: platform }, getResourcesDir: () => resources }
    }
  }
}
afterEach(() => {
  for (const root of fixtures.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('zen-opencode-pack-test-'))
      throw new Error('Unexpected fixture path')
    fs.rmSync(root, { recursive: true, force: true })
  }
})
describe('OpenCode native installer resources', () => {
  it.each([
    ['mac', 'arm64'],
    ['mac', 'x64'],
    ['windows', 'arm64'],
    ['windows', 'x64']
  ] as const)('copies only a verified %s %s executable outside ASAR', (platform, arch) => {
    const data = fixture(platform, arch)
    const result = copyOpenCodeRuntime(data.context, data.root)
    expect(result).toContain(`${path.sep}resources${path.sep}opencode${path.sep}`)
    expect(fs.readFileSync(result)).toEqual(fs.readFileSync(data.binary))
    expect(fs.lstatSync(result).isFile()).toBe(true)
  })
  it('fails the build rather than shipping an unavailable runtime', () => {
    const data = fixture('mac', 'arm64')
    fs.unlinkSync(data.binary)
    expect(() => copyOpenCodeRuntime(data.context, data.root)).toThrow()
  })
  it('copies the actual offline lockfile, plugin tree and both licenses outside ASAR', () => {
    const data = fixture('windows', 'x64')
    const bundle = path.join(data.root, 'resources', 'opencode-runtime')
    fs.mkdirSync(path.join(bundle, 'node_modules', '@opencode-ai', 'plugin'), { recursive: true })
    fs.writeFileSync(path.join(bundle, 'package.json'), '{"private":true}')
    fs.writeFileSync(path.join(bundle, 'package-lock.json'), '{"lockfileVersion":3}')
    fs.writeFileSync(
      path.join(bundle, 'node_modules', '@opencode-ai', 'plugin', 'package.json'),
      '{"version":"1.18.35"}'
    )
    const licenses = path.join(data.root, 'resources', 'licenses')
    fs.mkdirSync(licenses, { recursive: true })
    for (const name of ['opencode-LICENSE.txt', 'opencode-dependencies.txt'])
      fs.writeFileSync(path.join(licenses, name), 'MIT fixture')
    copyOpenCodeOfflineRuntime(data.context, data.root)
    const target = data.context.packager.getResourcesDir()
    expect(fs.readFileSync(path.join(target, 'opencode-runtime', 'package-lock.json'), 'utf8')).toContain(
      'lockfileVersion'
    )
    expect(
      fs.existsSync(path.join(target, 'opencode-runtime', 'node_modules', '@opencode-ai', 'plugin', 'package.json'))
    ).toBe(true)
    expect(fs.existsSync(path.join(target, 'licenses', 'opencode-LICENSE.txt'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'licenses', 'opencode-dependencies.txt'))).toBe(true)
  })
  it('refuses to package an incomplete offline dependency tree', () => {
    const data = fixture('windows', 'x64')
    expect(() => copyOpenCodeOfflineRuntime(data.context, data.root)).toThrow('offline resource missing')
  })
})
