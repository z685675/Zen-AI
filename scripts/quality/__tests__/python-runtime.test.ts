import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { MANAGED_PYTHON_PACKAGES } from '../../../src/main/services/python/ManagedPythonConfig'
import {
  acquireQualityPython,
  mountQualityPython,
  prepareQualityPython,
  qualityPythonKey,
  validateQualityPython
} from '../python-runtime'

const success = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
  durationMs: 1,
  stdout: '',
  stderr: '',
  outputTruncated: false,
  terminationUnconfirmed: false
}

describe('dedicated quality Python, never the normal user environment', () => {
  it('keys caches by platform and architecture and never steals an active batch lease', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'quality-python-'))
    try {
      expect(qualityPythonKey('win32', 'x64')).not.toBe(qualityPythonKey('darwin', 'x64'))
      expect(qualityPythonKey('darwin', 'x64')).not.toBe(qualityPythonKey('darwin', 'arm64'))
      const first = await acquireQualityPython(root)
      await expect(acquireQualityPython(root)).rejects.toThrow('另一批验收占用')
      await first.release()
      const next = await acquireQualityPython(root)
      expect(next.cacheDir).toBe(first.cacheDir)
      await next.release()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('mounts only Python into fresh instances; never replaces an existing path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'quality-python-mount-'))
    try {
      const lease = await acquireQualityPython(root)
      for (const name of ['one', 'two']) {
        const instance = path.join(root, name)
        await mkdir(instance)
        await mountQualityPython(root, instance, lease)
        expect(await realpath(path.join(instance, 'userData/runtimes/python'))).toBe(
          await realpath(path.join(lease.cacheDir, 'python'))
        )
        await expect(mountQualityPython(root, instance, lease)).rejects.toThrow()
      }
      await expect(validateQualityPython(root, { ...lease, key: 'wrong-profile' })).rejects.toThrow('不匹配')
      await expect(validateQualityPython(root, { ...lease, cacheDir: root })).rejects.toThrow('不匹配')
      await lease.release()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a redirected cache directory instead of touching a user environment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'quality-python-redirect-'))
    try {
      const outside = path.join(root, 'untouched')
      await mkdir(outside)
      await mkdir(path.join(root, 'local'))
      await symlink(
        outside,
        path.join(root, 'local/quality-runtimes'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      await expect(acquireQualityPython(root)).rejects.toThrow('符号链接')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['success', 'bad-proof', 'process-failed', 'unconfirmed-exit', 'cancelled'])(
    'keeps credentials out of the setup process and records truthful evidence: %s',
    async (mode) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'quality-python-preflight-'))
      const directory = path.join(root, 'local/quality-reports/synthetic')
      const secret = 'private-fixture-never-forwarded'
      process.env.ZEN_QUALITY_SESSION_TEST_KEY = secret
      const run = vi.fn(async (_command, options) => {
        expect(JSON.stringify(options.env)).not.toContain(secret)
        expect(options.env.ZEN_QUALITY_SESSION_TEST_KEY).toBeUndefined()
        expect(options.env.HOME).toContain('quality-runtimes')
        const request = JSON.parse(await readFile(options.env.ZEN_QUALITY_PYTHON_REQUEST, 'utf8'))
        const executablePath = path.join(request.cacheDir, 'python', 'synthetic-python')
        await writeFile(executablePath, 'not executed by mocked test')
        await writeFile(
          path.join(directory, 'python-preflight/result.json'),
          JSON.stringify({
            key: request.key,
            ready: true,
            executablePath,
            pythonVersion: '3.12.9',
            bits: 64,
            sum: mode === 'bad-proof' ? 14 : 89,
            xlsxRoundTrip: true,
            packages: MANAGED_PYTHON_PACKAGES.map(({ id }) => id),
            versions: Object.fromEntries(MANAGED_PYTHON_PACKAGES.map(({ id }) => [id, 'synthetic']))
          })
        )
        return {
          ...success,
          exitCode: mode === 'process-failed' ? 1 : 0,
          terminationUnconfirmed: mode === 'unconfirmed-exit'
        }
      })
      try {
        const signal = mode === 'cancelled' ? AbortSignal.abort() : undefined
        // Resolve Electron from the real project, but no executable or network is invoked by this test.
        const { createRequire } = await import('node:module')
        const require = createRequire(import.meta.url)
        await mkdir(path.join(root, 'node_modules'), { recursive: true })
        await symlink(
          path.dirname(require.resolve('electron/package.json')),
          path.join(root, 'node_modules/electron'),
          process.platform === 'win32' ? 'junction' : 'dir'
        )
        const prepare = prepareQualityPython(root, directory, signal, { execute: run })
        if (mode === 'success') {
          const lease = await prepare
          const proof = JSON.parse(await readFile(path.join(directory, 'python-environment.json'), 'utf8'))
          expect(proof).toMatchObject({ ready: true, sum: 89, xlsxRoundTrip: true })
          await expect(acquireQualityPython(root)).rejects.toThrow('占用')
          await lease.release()
        } else {
          await expect(prepare).rejects.toThrow()
          expect(JSON.parse(await readFile(path.join(directory, 'python-environment.json'), 'utf8')).ready).toBe(false)
          if (mode === 'unconfirmed-exit') await expect(acquireQualityPython(root)).rejects.toThrow('占用')
          else {
            const lease = await acquireQualityPython(root)
            await lease.release()
          }
        }
        if (mode === 'cancelled') expect(run).not.toHaveBeenCalled()
      } finally {
        delete process.env.ZEN_QUALITY_SESSION_TEST_KEY
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
