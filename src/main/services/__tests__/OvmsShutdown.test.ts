import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ exists: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ exec: vi.fn(), execFile: harness.execFile }))
vi.mock('fs-extra', () => ({ pathExists: harness.exists }))
vi.mock('@main/constant', () => ({ isWin: true }))
vi.mock('@main/utils/system', () => ({ getCpuName: () => 'Intel' }))
vi.mock('node:os', () => ({ homedir: () => 'C:/isolated-quality-user' }))

import { ovmsManager } from '../OvmsManager'

beforeEach(() => {
  vi.clearAllMocks()
  harness.exists.mockResolvedValue(false)
  harness.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''))
})

describe('owned OVMS shutdown', () => {
  it('does not spawn PowerShell when the local runtime was never installed', async () => {
    await expect(ovmsManager!.stopOvms()).resolves.toEqual({ success: true })
    expect(harness.execFile).not.toHaveBeenCalled()
  })

  it('uses one bounded profile-free command scoped to the app executable', async () => {
    harness.exists.mockResolvedValue(true)
    await expect(ovmsManager!.stopOvms()).resolves.toHaveProperty('success', true)
    expect(harness.execFile).toHaveBeenCalledOnce()
    const [file, args, options] = harness.execFile.mock.calls[0]
    expect(file).toBe('powershell.exe')
    expect(args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      expect.stringContaining('$_.ExecutablePath -eq $env:ZEN_OVMS_EXECUTABLE')
    ])
    expect(options).toMatchObject({ windowsHide: true, timeout: 5000, killSignal: 'SIGKILL' })
    expect(options.env.ZEN_OVMS_EXECUTABLE.replaceAll('\\', '/')).toMatch(
      /^C:\/isolated-quality-user\/[^/]+\/ovms\/ovms\/ovms\.exe$/
    )
    expect(args.join(' ')).not.toMatch(/CommandLine -like|Get-WmiObject|\bovms\.exe\*/)
  })

  it('reports a timed-out or denied stop rather than returning success', async () => {
    harness.exists.mockResolvedValue(true)
    harness.execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(Object.assign(new Error('PowerShell timeout'), { killed: true }))
    )
    await expect(ovmsManager!.stopOvms()).resolves.toHaveProperty('success', false)
  })
})
