import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseCurrentVersion, parseUpdateStatus } from '../utils/openClawParsers'

vi.mock('@main/services/WindowService', () => ({
  windowService: {
    getMainWindow: vi.fn(() => ({
      webContents: { send: vi.fn() }
    }))
  }
}))

vi.mock('@main/utils/process', () => ({
  crossPlatformSpawn: vi.fn(),
  findExecutableInEnv: vi.fn(),
  getBinaryPath: vi.fn(() => Promise.resolve('/mock/bin/openclaw')),
  runInstallScript: vi.fn()
}))

vi.mock('@main/utils/shell-env', () => ({
  default: vi.fn(() => Promise.resolve({ PATH: '/usr/bin' })),
  refreshShellEnv: vi.fn(() => Promise.resolve({ PATH: '/usr/bin' }))
}))

vi.mock('@main/utils/ipService', () => ({
  isUserInChina: vi.fn(() => Promise.resolve(false))
}))

vi.mock('@main/constant', () => ({
  isWin: false
}))

vi.mock('@shared/IpcChannel', () => ({
  IpcChannel: { OpenClaw_InstallProgress: 'openclaw:install-progress' }
}))

vi.mock('@shared/utils', () => ({
  hasAPIVersion: vi.fn(() => false),
  withoutTrailingSlash: vi.fn((url: string) => url.replace(/\/+$/, '')),
  formatApiHost: vi.fn((url: string) => url)
}))

vi.mock('../VertexAIService', () => ({
  default: { getInstance: vi.fn() }
}))

async function createService() {
  const mod = await import('../OpenClawService')
  return mod.openClawService
}

describe('OpenClawService gateway state machine', () => {
  let service: Awaited<ReturnType<typeof createService>>
  let checkHealthSpy: ReturnType<typeof vi.spyOn>
  let findBinarySpy: ReturnType<typeof vi.spyOn>
  let checkPortOpenSpy: ReturnType<typeof vi.spyOn>
  let startAndWaitSpy: ReturnType<typeof vi.spyOn>
  let stopGatewaySpy: ReturnType<typeof vi.spyOn>
  let waitForGatewayStopSpy: ReturnType<typeof vi.spyOn>
  let killAllSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.clearAllMocks()
    service = await createService()

    ;(service as any).gatewayStatus = 'stopped'
    ;(service as any).gatewayPort = 18790
    ;(service as any).gatewayAuthToken = ''

    checkHealthSpy = vi.spyOn(service as any, 'checkGatewayHealth')
    findBinarySpy = vi.spyOn(service as any, 'findOpenClawBinary')
    checkPortOpenSpy = vi.spyOn(service as any, 'checkPortOpen')
    startAndWaitSpy = vi.spyOn(service as any, 'startAndWaitForGateway')
    stopGatewaySpy = vi.spyOn(service, 'stopGateway')
    waitForGatewayStopSpy = vi.spyOn(service as any, 'waitForGatewayStop')
    killAllSpy = vi.spyOn(service as any, 'killAllOpenClawProcesses').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getStatus', () => {
    it('returns starting immediately without probing', async () => {
      ;(service as any).gatewayStatus = 'starting'
      await expect(service.getStatus()).resolves.toEqual({ status: 'starting', port: 18790 })
      expect(checkHealthSpy).not.toHaveBeenCalled()
    })

    it('detects externally running gateway', async () => {
      checkHealthSpy.mockResolvedValue({ status: 'healthy', gatewayPort: 18790 })
      await expect(service.getStatus()).resolves.toEqual({ status: 'running', port: 18790 })
    })

    it('marks a crashed running gateway as stopped', async () => {
      ;(service as any).gatewayStatus = 'running'
      checkHealthSpy.mockResolvedValue({ status: 'unhealthy', gatewayPort: 18790 })
      await expect(service.getStatus()).resolves.toEqual({ status: 'stopped', port: 18790 })
    })
  })

  describe('checkHealth', () => {
    it('returns unhealthy immediately when gateway is not running', async () => {
      ;(service as any).gatewayStatus = 'stopped'
      await expect(service.checkHealth()).resolves.toEqual({ status: 'unhealthy', gatewayPort: 18790 })
      expect(checkHealthSpy).not.toHaveBeenCalled()
    })

    it('probes and keeps running state when healthy', async () => {
      ;(service as any).gatewayStatus = 'running'
      checkHealthSpy.mockResolvedValue({ status: 'healthy', gatewayPort: 18790 })
      await expect(service.checkHealth()).resolves.toEqual({ status: 'healthy', gatewayPort: 18790 })
      expect((service as any).gatewayStatus).toBe('running')
    })

    it('marks running gateway as stopped when unhealthy', async () => {
      ;(service as any).gatewayStatus = 'running'
      checkHealthSpy.mockResolvedValue({ status: 'unhealthy', gatewayPort: 18790 })
      await expect(service.checkHealth()).resolves.toEqual({ status: 'unhealthy', gatewayPort: 18790 })
      expect((service as any).gatewayStatus).toBe('stopped')
    })
  })

  describe('startGateway', () => {
    const event = {} as Electron.IpcMainInvokeEvent

    it('rejects concurrent startup calls', async () => {
      ;(service as any).gatewayStatus = 'starting'
      await expect(service.startGateway(event)).resolves.toEqual({
        success: false,
        message: 'Gateway is already starting'
      })
    })

    it('fails when port is occupied by another app', async () => {
      checkPortOpenSpy.mockResolvedValue(true)
      checkHealthSpy.mockResolvedValue({ status: 'unhealthy', gatewayPort: 18790 })

      const result = await service.startGateway(event)
      expect(result.success).toBe(false)
      expect(result.message).toContain('already in use')
    })

    it('stops stale gateway and restarts when health check is healthy', async () => {
      checkPortOpenSpy.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      checkHealthSpy.mockResolvedValue({ status: 'healthy', gatewayPort: 18790 })
      stopGatewaySpy.mockResolvedValue({ success: true })
      findBinarySpy.mockResolvedValue('/mock/bin/openclaw')
      startAndWaitSpy.mockResolvedValue(undefined)

      await expect(service.startGateway(event)).resolves.toEqual({ success: true })
      expect(stopGatewaySpy).toHaveBeenCalled()
      expect((service as any).gatewayStatus).toBe('running')
    })

    it('fails when binary is missing', async () => {
      checkPortOpenSpy.mockResolvedValue(false)
      findBinarySpy.mockResolvedValue(null)

      await expect(service.startGateway(event)).resolves.toEqual({
        success: false,
        message: 'OpenClaw binary not found. Please install OpenClaw first.'
      })
    })

    it('keeps custom port and enters error state on startup failure', async () => {
      checkPortOpenSpy.mockResolvedValue(false)
      findBinarySpy.mockResolvedValue('/mock/bin/openclaw')
      startAndWaitSpy.mockRejectedValue(new Error('Gateway timeout'))

      await expect(service.startGateway(event, 9999)).resolves.toEqual({
        success: false,
        message: 'Gateway timeout'
      })
      expect((service as any).gatewayPort).toBe(9999)
      expect((service as any).gatewayStatus).toBe('error')
    })
  })

  describe('stopGateway', () => {
    it('transitions to stopped on successful stop', async () => {
      ;(service as any).gatewayStatus = 'running'
      waitForGatewayStopSpy.mockResolvedValue(false)

      await expect(service.stopGateway()).resolves.toEqual({ success: true })
      expect(killAllSpy).toHaveBeenCalled()
      expect((service as any).gatewayStatus).toBe('stopped')
    })

    it('transitions to error when gateway remains running', async () => {
      ;(service as any).gatewayStatus = 'running'
      waitForGatewayStopSpy.mockResolvedValue(true)

      const result = await service.stopGateway()
      expect(result.success).toBe(false)
      expect((service as any).gatewayStatus).toBe('error')
    })
  })
})

describe('parseCurrentVersion', () => {
  it.each([
    ['OpenClaw 2026.3.9 (fe96034)', '2026.3.9'],
    ['OpenClaw 2026.3.11', '2026.3.11'],
    ['openclaw 1.0.0 (abc1234)', '1.0.0'],
    ['', null],
    ['some random text', null]
  ])('parses %s', (input, expected) => {
    expect(parseCurrentVersion(input)).toBe(expected)
  })
})

describe('parseUpdateStatus', () => {
  it.each([
    ['Update available (binary 2026.3.12). Run: openclaw update', '2026.3.12'],
    ['available | binary | 2026.3.12', '2026.3.12'],
    [
      ['OpenClaw update status', 'Install  | binary (~/.zen-ai/bin)', 'Update   | available | binary | 2026.3.12'].join(
        '\n'
      ),
      '2026.3.12'
    ],
    ['Update available (npm 2026.3.11). Run: openclaw update', null],
    ['Update available | pkg | npm update 2026.3.11', null],
    ['Already up to date', null]
  ])('parses update status from %s', (input, expected) => {
    expect(parseUpdateStatus(input)).toBe(expected)
  })
})
