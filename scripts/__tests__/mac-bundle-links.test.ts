import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const { prepareMacBundleLinks, verifyMacBundleLinks } = require_('../mac-bundle-links.js')
const fixtures: string[] = []

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-mac-links-test-'))
  fixtures.push(root)
  const bundle = path.join(root, 'dist', 'Zen AI.app')
  const resources = path.join(bundle, 'Contents', 'Resources')
  fs.mkdirSync(resources, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}')
  return { root, bundle, resources }
}

function directoryLink(source: string, destination: string) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('zen-mac-links-test-'))
      throw new Error('Unexpected fixture path')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('Mac bundle symlinks before signing', () => {
  it('leaves a self-contained bundle unchanged', () => {
    const data = fixture()
    fs.writeFileSync(path.join(data.resources, 'app.asar'), 'asar fixture')
    expect(prepareMacBundleLinks(data.resources, data.root)).toEqual([])
  })

  it('materializes a build-machine dependency link without modifying its source', () => {
    const data = fixture()
    const source = path.join(data.root, 'node_modules', '.pnpm', 'library@1', 'node_modules', 'library')
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = 42')
    const destination = path.join(data.resources, 'app.asar.unpacked', 'node_modules', 'library')
    directoryLink(source, destination)
    expect(() => verifyMacBundleLinks(data.bundle)).toThrow('Invalid bundle symlink')
    expect(prepareMacBundleLinks(data.resources, data.root)).toEqual([path.relative(data.bundle, destination)])
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(destination, 'index.js'), 'utf8')).toBe('module.exports = 42')
    expect(fs.readFileSync(path.join(source, 'index.js'), 'utf8')).toBe('module.exports = 42')
    expect(() => verifyMacBundleLinks(data.bundle)).not.toThrow()
  })

  it('materializes internal absolute resource links while retaining their target', () => {
    const data = fixture()
    const source = path.join(data.resources, 'actual')
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'asset'), 'asset fixture')
    const link = path.join(data.resources, 'alias')
    directoryLink(source, link)
    prepareMacBundleLinks(data.resources, data.root)
    expect(fs.lstatSync(link).isDirectory()).toBe(true)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(link, 'asset'), 'utf8')).toBe('asset fixture')
    expect(fs.existsSync(source)).toBe(true)
  })

  it('rejects a resource link to arbitrary files outside the approved build trees', () => {
    const data = fixture()
    const source = path.join(data.root, 'private')
    fs.mkdirSync(source)
    const link = path.join(data.resources, 'invalid')
    directoryLink(source, link)
    expect(() => prepareMacBundleLinks(data.resources, data.root)).toThrow('outside allowed build resources')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(source)).toBe(true)
  })

  it('rejects a link to a parent directory rather than copying recursively', () => {
    const data = fixture()
    const link = path.join(data.resources, 'recursive')
    directoryLink(data.resources, link)
    expect(() => prepareMacBundleLinks(data.resources, data.root)).toThrow('Circular resource symlink')
  })

  it('does not copy an unsafe link hidden inside a dependency directory', () => {
    const data = fixture()
    const source = path.join(data.root, 'node_modules', 'library')
    const privateDirectory = path.join(data.root, 'private')
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(privateDirectory)
    directoryLink(privateDirectory, path.join(source, 'nested'))
    const link = path.join(data.resources, 'library')
    directoryLink(source, link)
    expect(() => prepareMacBundleLinks(data.resources, data.root)).toThrow('Unsafe or missing nested symlink source')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
  })

  it('rejects indirect dependency cycles without hanging or replacing the original link', () => {
    const data = fixture()
    const source = path.join(data.root, 'node_modules', 'library')
    const other = path.join(data.root, 'node_modules', 'other')
    fs.mkdirSync(source, { recursive: true })
    fs.mkdirSync(other)
    directoryLink(other, path.join(source, 'other'))
    directoryLink(source, path.join(other, 'library'))
    const link = path.join(data.resources, 'library')
    directoryLink(source, link)
    expect(() => prepareMacBundleLinks(data.resources, data.root)).toThrow('Circular nested symlink source')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
  })

  it('refuses an output directory that is not an app bundle Resources directory', () => {
    const data = fixture()
    expect(() => prepareMacBundleLinks(data.root, data.root)).toThrow('Not an application Resources directory')
  })

  // Windows requires additional privileges for file/relative symlinks. The Mac
  // release job runs these real filesystem cases before packaging/signing.
  it.runIf(process.platform !== 'win32')('recovers a relocated pnpm link from the exact source dependency', () => {
    const data = fixture()
    const source = path.join(data.root, 'node_modules', 'library')
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'binary'), 'binary fixture', { mode: 0o755 })
    const directory = path.join(data.resources, 'app.asar.unpacked', 'node_modules', 'library')
    fs.mkdirSync(directory, { recursive: true })
    const link = path.join(directory, 'binary')
    fs.symlinkSync('../../.pnpm/library@1/node_modules/library/binary', link)
    expect(fs.existsSync(link)).toBe(false)
    prepareMacBundleLinks(data.resources, data.root)
    expect(fs.lstatSync(link).isFile()).toBe(true)
    expect(fs.readFileSync(link, 'utf8')).toBe('binary fixture')
    expect(fs.statSync(link).mode & 0o111).toBe(0o111)
  })

  it.runIf(process.platform !== 'win32')('does not alter valid Electron framework links', () => {
    const data = fixture()
    const framework = path.join(data.bundle, 'Contents', 'Frameworks', 'Electron Framework.framework')
    const version = path.join(framework, 'Versions', 'A')
    fs.mkdirSync(version, { recursive: true })
    fs.writeFileSync(path.join(version, 'Electron Framework'), 'framework fixture')
    fs.symlinkSync('A', path.join(framework, 'Versions', 'Current'))
    fs.symlinkSync('Versions/Current/Electron Framework', path.join(framework, 'Electron Framework'))
    prepareMacBundleLinks(data.resources, data.root)
    expect(fs.readlinkSync(path.join(framework, 'Versions', 'Current'))).toBe('A')
    expect(fs.readlinkSync(path.join(framework, 'Electron Framework'))).toBe('Versions/Current/Electron Framework')
  })

  it.runIf(process.platform !== 'win32')('reports the exact dangling resource link and leaves it intact', () => {
    const data = fixture()
    const link = path.join(data.resources, 'missing')
    fs.symlinkSync('does-not-exist', link)
    expect(() => prepareMacBundleLinks(data.resources, data.root)).toThrow(`${link} -> does-not-exist`)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
  })

  it.runIf(process.platform !== 'win32')(
    'rejects invalid framework links instead of disabling signature validation',
    () => {
      const data = fixture()
      const framework = path.join(data.bundle, 'Contents', 'Frameworks')
      fs.mkdirSync(framework)
      const link = path.join(framework, 'missing')
      fs.symlinkSync('does-not-exist', link)
      expect(() => prepareMacBundleLinks(data.resources, data.root)).toThrow(`${link} -> does-not-exist`)
    }
  )
})
