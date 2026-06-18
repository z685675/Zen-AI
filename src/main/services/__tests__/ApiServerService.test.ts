import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiServerStart: vi.fn(),
  apiServerStop: vi.fn(),
  apiServerRestart: vi.fn(),
  apiServerIsRunning: vi.fn(),
  getConfig: vi.fn(),
  bootstrapBuiltinAgents: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:/tmp/zen-ai-test'),
    getVersion: vi.fn(() => '0.0.0-test')
  },
  ipcMain: {
    handle: vi.fn()
  }
}))

vi.mock('../../apiServer', () => ({
  apiServer: {
    start: (...args: unknown[]) => mocks.apiServerStart(...args),
    stop: (...args: unknown[]) => mocks.apiServerStop(...args),
    restart: (...args: unknown[]) => mocks.apiServerRestart(...args),
    isRunning: (...args: unknown[]) => mocks.apiServerIsRunning(...args)
  },
  config: {
    get: (...args: unknown[]) => mocks.getConfig(...args)
  }
}))

vi.mock('../../apiServer/server', () => ({
  apiServer: {
    start: (...args: unknown[]) => mocks.apiServerStart(...args),
    stop: (...args: unknown[]) => mocks.apiServerStop(...args),
    restart: (...args: unknown[]) => mocks.apiServerRestart(...args),
    isRunning: (...args: unknown[]) => mocks.apiServerIsRunning(...args)
  }
}))

vi.mock('../../apiServer/config', () => ({
  config: {
    get: (...args: unknown[]) => mocks.getConfig(...args)
  }
}))

vi.mock('../agents/services/builtin/BuiltinAgentBootstrap', () => ({
  bootstrapBuiltinAgents: (...args: unknown[]) => mocks.bootstrapBuiltinAgents(...args)
}))

vi.mock('../LoggerService', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })
  }
}))

import { ApiServerService } from '../ApiServerService'

describe('ApiServerService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.apiServerStart.mockResolvedValue(undefined)
    mocks.apiServerStop.mockResolvedValue(undefined)
    mocks.apiServerRestart.mockResolvedValue(undefined)
    mocks.apiServerIsRunning.mockReturnValue(false)
    mocks.getConfig.mockResolvedValue({ enabled: false, host: '127.0.0.1', port: 23336, apiKey: 'cs-sk-test' })
    mocks.bootstrapBuiltinAgents.mockResolvedValue(undefined)
  })

  it('bootstraps built-in agents before manual API server start', async () => {
    const calls: string[] = []
    mocks.bootstrapBuiltinAgents.mockImplementation(async () => {
      calls.push('bootstrap')
    })
    mocks.apiServerStart.mockImplementation(async () => {
      calls.push('start')
    })

    await new ApiServerService().start()

    expect(calls).toEqual(['bootstrap', 'start'])
  })

  it('can skip bootstrapping when startup already initialized built-in agents', async () => {
    await new ApiServerService().start({ ensureBuiltinAgents: false })

    expect(mocks.bootstrapBuiltinAgents).not.toHaveBeenCalled()
    expect(mocks.apiServerStart).toHaveBeenCalledTimes(1)
  })

  it('bootstraps built-in agents before API server restart', async () => {
    await new ApiServerService().restart()

    expect(mocks.bootstrapBuiltinAgents).toHaveBeenCalledTimes(1)
    expect(mocks.apiServerRestart).toHaveBeenCalledTimes(1)
  })
})
