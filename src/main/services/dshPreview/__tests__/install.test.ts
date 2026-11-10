import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DSH_PREVIEW_VERSION } from '@shared/dshPreview'
import { c as createTar } from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:fs')

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), spawn: vi.fn(), resources: '', data: '' }))
vi.mock('electron', () => ({ app: { isPackaged: false }, net: { fetch: mocks.fetch } }))
vi.mock('@main/utils', () => ({
  getDataPath: () => mocks.data,
  getResourcePath: () => mocks.resources,
  toAsarUnpackedPath: (value: string) => value
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

let directory: string
let npmBytes: Buffer
let nodeBytes: Buffer
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-dsh-install-test-'))
  mocks.resources = path.join(directory, 'resources')
  mocks.data = path.join(directory, 'data')
  const resource = path.join(mocks.resources, 'dsh-runtime')
  await fs.mkdir(resource, { recursive: true })
  await fs.mkdir(path.join(directory, 'package/bin'), { recursive: true })
  await fs.writeFile(path.join(directory, 'package/package.json'), JSON.stringify({ version: '11.13.0' }))
  await fs.writeFile(path.join(directory, 'package/bin/npm-cli.js'), '// Mock npm bootstrap')
  await createTar({ gzip: true, cwd: directory, file: path.join(directory, 'npm.tgz') }, ['package'])
  npmBytes = await fs.readFile(path.join(directory, 'npm.tgz'))
  let nodeFile = 'win-x64/node.exe'
  nodeBytes = Buffer.from('official-node-test-fixture')
  if (process.platform !== 'win32') {
    nodeFile = `node-v24.17.0-${process.platform}-${process.arch}.tar.gz`
    const prefix = nodeFile.replace(/\.tar\.gz$/, '')
    await fs.mkdir(path.join(directory, prefix, 'bin'), { recursive: true })
    await fs.writeFile(path.join(directory, prefix, 'bin/node'), nodeBytes)
    await createTar({ gzip: true, cwd: directory, file: path.join(directory, nodeFile) }, [prefix])
    nodeBytes = await fs.readFile(path.join(directory, nodeFile))
  }
  await fs.writeFile(
    path.join(resource, 'node.json'),
    JSON.stringify({
      version: '24.17.0',
      artifacts: {
        [`${process.platform}-${process.arch}`]: {
          file: nodeFile,
          sha256: createHash('sha256').update(nodeBytes).digest('hex')
        }
      }
    })
  )
  await fs.writeFile(
    path.join(resource, 'bootstrap.json'),
    JSON.stringify({
      version: '11.13.0',
      url: 'https://registry.npmjs.org/npm/-/npm-11.13.0.tgz',
      integrity: `sha512-${createHash('sha512').update(npmBytes).digest('base64')}`
    })
  )
  await fs.writeFile(path.join(resource, 'package.json'), '{}')
  await fs.writeFile(path.join(resource, 'package-lock.json'), '{}')
  await fs.writeFile(path.join(resource, 'bridge.mjs'), '// Mock bridge')
  mocks.fetch.mockImplementation(
    async (url: string) => new Response(url.startsWith('https://nodejs.org/') ? nodeBytes : npmBytes)
  )
  mocks.spawn.mockImplementation((_exe: string, args: string[], options: { cwd: string }) => {
    const child = Object.assign(new EventEmitter(), { pid: 987654, kill: vi.fn() })
    queueMicrotask(async () => {
      if (args.includes('ci')) {
        const native = path.join(options.cwd, 'node_modules/@deepseek-ai/dsh')
        await fs.mkdir(path.join(native, 'lib'), { recursive: true })
        await fs.writeFile(path.join(native, 'package.json'), JSON.stringify({ version: DSH_PREVIEW_VERSION }))
        await fs.writeFile(path.join(native, 'lib/bin.js'), '// Mock native entry')
      }
      child.emit('close', 0)
    })
    return child
  })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  // The target is the exact private mkdtemp directory created above.
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

describe('Explicit optional DSH preparation', () => {
  it('stays idle on import, deduplicates preparation, verifies bytes and boots before ready', async () => {
    const install = await import('../install')
    expect(install.getDshPreviewRuntimeStatus().state).toBe('not-installed')
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
    vi.stubEnv('OPENAI_API_KEY', 'ambient-key-must-not-leak')
    const first = install.prepareDshPreviewRuntime()
    expect(install.prepareDshPreviewRuntime()).toBe(first)
    const prepared = await first
    expect(install.getDshPreviewRuntimeStatus()).toEqual({ version: DSH_PREVIEW_VERSION, state: 'ready' })
    expect(prepared.execPath).toContain('node-24.17.0')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    const installCall = mocks.spawn.mock.calls.find((call) => call[1].includes('ci'))!
    expect(installCall[1]).toContain('--ignore-scripts')
    expect(installCall[2].env.OPENAI_API_KEY).toBeUndefined()
    expect(installCall[2].env.DSH_HOME).toContain(mocks.data)
    expect(mocks.spawn.mock.calls.some((call) => call[1].includes('--verify'))).toBe(true)
    expect(install.getPreparedDshRuntime()).toEqual(prepared)
  })

  it('rejects altered official Node bytes before executing any child', async () => {
    const install = await import('../install')
    mocks.fetch.mockResolvedValue(new Response('tampered download'))
    await expect(install.prepareDshPreviewRuntime()).rejects.toThrow('integrity mismatch')
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(install.getDshPreviewRuntimeStatus()).toMatchObject({ state: 'error' })
    expect(JSON.stringify(install.getDshPreviewRuntimeStatus())).not.toContain(directory)
    expect(() => install.getPreparedDshRuntime()).toThrow('Prepare')
  })

  it('rejects altered npm bootstrap bytes before extracting or executing the installer', async () => {
    const install = await import('../install')
    mocks.fetch.mockImplementation(
      async (url: string) =>
        new Response(url.startsWith('https://nodejs.org/') ? nodeBytes : Buffer.from('altered npm tarball'))
    )
    await expect(install.prepareDshPreviewRuntime()).rejects.toThrow('Installer integrity mismatch')
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(install.getDshPreviewRuntimeStatus().state).toBe('error')
  })

  it('terminates the owned installer process tree when preparation is cancelled', async () => {
    const install = await import('../install')
    let installer: EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> }
    mocks.spawn.mockImplementation((executable: string) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 987654,
        kill: vi.fn(() => queueMicrotask(() => child.emit('close', null)))
      })
      if (executable === 'taskkill')
        queueMicrotask(() => {
          installer.emit('close', null)
          child.emit('close', 0)
        })
      else installer = child
      return child
    })
    const first = install.prepareDshPreviewRuntime()
    const rejection = expect(first).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(install.getDshPreviewRuntimeStatus().progress).toBe('installing-runtime'))
    await install.cancelDshPreviewPreparation()
    await rejection
    if (process.platform === 'win32')
      expect(mocks.spawn).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', '987654', '/T', '/F'],
        expect.objectContaining({ windowsHide: true })
      )
    else expect(installer!.kill).toHaveBeenCalledWith('SIGKILL')
    expect(install.getDshPreviewRuntimeStatus().state).toBe('not-installed')
    await expect(fs.stat(path.join(mocks.data, `runtime-${DSH_PREVIEW_VERSION}`))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('cancels a pending download and clears the preparing state without exposing logs', async () => {
    const install = await import('../install')
    mocks.fetch.mockImplementation(
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        )
    )
    const first = install.prepareDshPreviewRuntime()
    const rejection = expect(first).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
    expect(install.getDshPreviewRuntimeStatus()).toMatchObject({ state: 'preparing', progress: 'downloading-node' })
    await install.cancelDshPreviewPreparation()
    await rejection
    expect(install.getDshPreviewRuntimeStatus().state).toBe('not-installed')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
