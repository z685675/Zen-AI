import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ exists: vi.fn(), stat: vi.fn(), access: vi.fn(), packaged: true }))
vi.mock('node:fs', () => ({
  existsSync: mocks.exists,
  statSync: mocks.stat,
  accessSync: mocks.access,
  constants: { X_OK: 1 }
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.packaged
    }
  }
}))
vi.mock('@main/utils', () => ({ toAsarUnpackedPath: (path: string) => path }))

import { OPENCODE_VERSION } from '../config'
import { inspectOpenCodeExecutable, resolveOpenCodeExecutable } from '../executable'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.packaged = true
  mocks.exists.mockReturnValue(true)
  mocks.stat.mockReturnValue({ isFile: () => true, size: 1234 })
  mocks.access.mockReturnValue(undefined)
  vi.stubGlobal('process', { ...process, resourcesPath: '/owned/resources' })
})

describe('export-only OpenCode executable inspection', () => {
  it.each(['arm64', 'x64'])('inspects the shipped Mac %s target without executing it', (arch) => {
    const info = inspectOpenCodeExecutable('darwin', arch)
    expect(info).toMatchObject({
      expectedVersion: OPENCODE_VERSION,
      resolutionStatus: 'resolved',
      exists: true,
      isFile: true,
      sizeBytes: 1234,
      executablePermission: true,
      snapshotTime: 'export-time'
    })
    expect(info.path?.replaceAll('\\', '/')).toBe(`/owned/resources/opencode/darwin-${arch}/opencode`)
  })
  it('records a missing installer binary with its expected path instead of fabricating a version', () => {
    mocks.exists.mockReturnValue(false)
    const info = inspectOpenCodeExecutable('darwin', 'arm64')
    expect(info).toMatchObject({ resolutionStatus: 'failed', exists: false, executablePermission: 'not-checked' })
    expect(info.path).toContain('darwin-arm64')
    expect(info.error).toContain('missing')
    expect(info).not.toHaveProperty('observedVersion')
    expect(() => resolveOpenCodeExecutable('darwin', 'arm64')).toThrow('missing')
  })
  it('records Mac execute-permission failure and Windows not-applicable separately', () => {
    mocks.access.mockImplementation(() => {
      throw new Error('EACCES')
    })
    expect(inspectOpenCodeExecutable('darwin', 'arm64').executablePermission).toBe(false)
    mocks.access.mockClear()
    const info = inspectOpenCodeExecutable('win32', 'x64')
    expect(info.path?.replaceAll('\\', '/')).toBe('/owned/resources/opencode/windows-x64/opencode.exe')
    expect(info.executablePermission).toBe('not-applicable-on-windows')
    expect(mocks.access).not.toHaveBeenCalled()
  })
})
