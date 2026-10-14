import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AssistantEnvironmentCheckResult, DependencyId } from '../AssistantEnvironmentService'

const api = {
  checkAssistantEnvironment: vi.fn(),
  installBunBinary: vi.fn(),
  installUVBinary: vi.fn(),
  installManagedPython: vi.fn(),
  installGitForWindows: vi.fn()
}

function status(missing: DependencyId[] = []): AssistantEnvironmentCheckResult {
  const dependency = (id: DependencyId) => ({
    id,
    installed: !missing.includes(id),
    source: missing.includes(id) ? ('missing' as const) : ('app' as const)
  })
  return {
    bun: dependency('bun'),
    uv: dependency('uv'),
    uvx: dependency('uvx'),
    python: dependency('python'),
    pyodide: dependency('pyodide'),
    binariesDir: '/owned/tools',
    checkedAt: Date.now()
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal('api', api)
  api.checkAssistantEnvironment.mockResolvedValue(status())
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('new assistant background environment preparation', () => {
  it('reuses a ready environment and performs startup preparation only once', async () => {
    const service = await import('../AssistantEnvironmentService')
    expect(service.AUTO_PREPARED_ASSISTANT_DEPENDENCIES).toEqual(['bun', 'uv', 'uvx', 'python'])
    await service.runStartupAssistantEnvironmentPreflight()
    await service.runStartupAssistantEnvironmentPreflight()
    expect(api.checkAssistantEnvironment).toHaveBeenCalledTimes(1)
    expect(api.installBunBinary).not.toHaveBeenCalled()
    expect(api.installUVBinary).not.toHaveBeenCalled()
    expect(api.installManagedPython).not.toHaveBeenCalled()
    expect(api.installGitForWindows).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('deduplicates startup and manual repair, publishes progress and prepares Python after UV', async () => {
    api.checkAssistantEnvironment.mockResolvedValueOnce(status(['bun', 'uv', 'uvx', 'python']))
    const service = await import('../AssistantEnvironmentService')
    const changed = vi.fn()
    const unsubscribe = service.subscribeAssistantEnvironment(changed)
    const first = service.runStartupAssistantEnvironmentPreflight()
    expect(service.getAssistantEnvironmentState().preparing).toBe(true)
    await Promise.all([first, service.repairRequiredAssistantEnvironment()])
    for (const install of [api.installBunBinary, api.installUVBinary, api.installManagedPython]) {
      expect(install).toHaveBeenCalledTimes(1)
    }
    expect(api.installUVBinary.mock.invocationCallOrder[0]).toBeLessThan(
      api.installManagedPython.mock.invocationCallOrder[0]
    )
    expect(api.installGitForWindows).not.toHaveBeenCalled()
    expect(changed.mock.calls[0][0].preparing).toBe(true)
    expect(changed.mock.calls.at(-1)![0]).toMatchObject({ preparing: false, result: status() })
    unsubscribe()
  })

  it('does not abandon other tools when a single installer fails', async () => {
    api.checkAssistantEnvironment
      .mockResolvedValueOnce(status(['bun', 'uvx', 'python']))
      .mockResolvedValue(status(['bun']))
    api.installBunBinary.mockRejectedValue(new Error('temporary download failure'))
    const service = await import('../AssistantEnvironmentService')
    const result = await service.repairRequiredAssistantEnvironment()
    expect(result.bun.installed).toBe(false)
    expect(result.python.installed).toBe(true)
    expect(api.installUVBinary).toHaveBeenCalledTimes(1)
    expect(api.installManagedPython).toHaveBeenCalledTimes(1)
    expect(service.getAssistantEnvironmentState().preparing).toBe(false)
  })

  it('makes only two delayed retries and does not repeatedly install ready components', async () => {
    api.checkAssistantEnvironment.mockResolvedValue(status(['bun']))
    api.installBunBinary.mockRejectedValue(new Error('offline'))
    const service = await import('../AssistantEnvironmentService')
    await expect(service.runStartupAssistantEnvironmentPreflight()).resolves.toBeUndefined()
    expect(api.installBunBinary).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.installBunBinary).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(api.installBunBinary).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
    expect(api.installUVBinary).not.toHaveBeenCalled()
    expect(api.installManagedPython).not.toHaveBeenCalled()
  })

  it('stops retrying when a transient startup failure recovers', async () => {
    api.checkAssistantEnvironment.mockRejectedValueOnce(new Error('temporary IPC failure'))
    const service = await import('../AssistantEnvironmentService')
    await service.runStartupAssistantEnvironmentPreflight()
    expect(service.getAssistantEnvironmentState()).toMatchObject({ preparing: false, error: 'temporary IPC failure' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.checkAssistantEnvironment).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    expect(service.getAssistantEnvironmentState().error).toBeNull()
  })

  it('does not treat optional sandbox connectivity as an installation requirement', async () => {
    api.checkAssistantEnvironment.mockResolvedValue(status(['pyodide']))
    const service = await import('../AssistantEnvironmentService')
    await service.runStartupAssistantEnvironmentPreflight()
    expect(vi.getTimerCount()).toBe(0)
    expect(api.installManagedPython).not.toHaveBeenCalled()
  })
})
