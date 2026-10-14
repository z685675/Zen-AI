import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  find: vi.fn(),
  python: vi.fn(),
  ensure: vi.fn()
}))
vi.mock('@main/utils/process', () => ({
  isBinaryExists: mocks.exists,
  findExecutableInEnv: mocks.find,
  getBinaryPath: async (name?: string) => `/owned/tools${name ? `/${name}` : ''}`
}))
vi.mock('../python/ManagedPythonService', () => ({
  managedPythonService: { getStatus: mocks.python, ensureReady: mocks.ensure }
}))

import { checkAssistantEnvironment, installManagedPython } from '../AssistantEnvironmentService'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.exists.mockResolvedValue(true)
  mocks.python.mockResolvedValue({ ready: true, installed: true, executablePath: '/owned/python', missingPackages: [] })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
})
afterEach(() => vi.unstubAllGlobals())

describe('assistant tool detection without legacy Git requirements', () => {
  it('reports private tools accurately and never checks or installs Git', async () => {
    const result = await checkAssistantEnvironment()
    expect(result.bun).toMatchObject({ installed: true, source: 'app', path: '/owned/tools/bun' })
    expect(result).not.toHaveProperty('git')
    expect(mocks.exists.mock.calls.map(([id]) => id)).toEqual(['bun', 'uv', 'uvx'])
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.ensure).not.toHaveBeenCalled()
  })

  it('reuses available system tools when no private copy is installed', async () => {
    mocks.exists.mockResolvedValue(false)
    mocks.find.mockImplementation(async (id: string) => `/system/${id}`)
    const result = await checkAssistantEnvironment()
    expect(result.uv).toMatchObject({ installed: true, source: 'system', path: '/system/uv' })
  })

  it('keeps a failed dependency separate from other ready tools', async () => {
    mocks.exists.mockImplementation(async (id: string) => {
      if (id === 'bun') throw new Error('cannot inspect tool')
      return true
    })
    const result = await checkAssistantEnvironment()
    expect(result.bun).toMatchObject({ installed: false, source: 'error', message: 'cannot inspect tool' })
    expect(result.uv.installed).toBe(true)
    expect(result.python.installed).toBe(true)
  })

  it('prepares only the managed Python runtime on an installation request', async () => {
    await installManagedPython()
    expect(mocks.ensure).toHaveBeenCalledTimes(1)
    expect(mocks.find).not.toHaveBeenCalled()
  })
})
