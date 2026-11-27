import { IpcChannel } from '@shared/IpcChannel'
import { ThemeMode } from '@types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const window = { isDestroyed: () => false, setTitleBarOverlay: vi.fn(), webContents: { send: vi.fn() } }
  return {
    window,
    getAllWindows: vi.fn(() => [window]),
    nativeTheme: { themeSource: 'system', shouldUseDarkColors: false, on: vi.fn() },
    setTheme: vi.fn()
  }
})

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: mocks.getAllWindows }, nativeTheme: mocks.nativeTheme }))
vi.mock('../ConfigManager', () => ({ configManager: { getTheme: () => 'system', setTheme: mocks.setTheme } }))
vi.mock('../../config', () => ({
  titleBarOverlayDark: { symbolColor: '#fff' },
  titleBarOverlayLight: { symbolColor: '#000' }
}))

import { themeService } from '../ThemeService'

describe('ThemeService', () => {
  beforeEach(() => {
    mocks.nativeTheme.shouldUseDarkColors = false
    mocks.window.setTitleBarOverlay.mockClear()
    mocks.window.webContents.send.mockClear()
    mocks.setTheme.mockClear()
  })

  it('persists the mode and applies the corresponding overlay', () => {
    mocks.nativeTheme.shouldUseDarkColors = true
    themeService.setTheme(ThemeMode.dark)
    expect(mocks.nativeTheme.themeSource).toBe(ThemeMode.dark)
    expect(mocks.setTheme).toHaveBeenCalledWith(ThemeMode.dark)
    expect(mocks.window.setTitleBarOverlay).toHaveBeenCalledWith({ symbolColor: '#fff' })
    expect(mocks.window.webContents.send).toHaveBeenCalledWith(IpcChannel.ThemeUpdated, ThemeMode.dark)

    mocks.nativeTheme.shouldUseDarkColors = false
    themeService.setTheme(ThemeMode.light)
    expect(mocks.window.setTitleBarOverlay).toHaveBeenLastCalledWith({ symbolColor: '#000' })
    expect(mocks.window.webContents.send).toHaveBeenLastCalledWith(IpcChannel.ThemeUpdated, ThemeMode.light)
  })

  it('refreshes the effective theme when the system appearance changes', () => {
    themeService.setTheme(ThemeMode.system)
    mocks.nativeTheme.shouldUseDarkColors = true
    const updated = mocks.nativeTheme.on.mock.calls.find(([event]) => event === 'updated')?.[1]
    expect(updated).toBeTypeOf('function')
    updated()
    expect(mocks.window.setTitleBarOverlay).toHaveBeenLastCalledWith({ symbolColor: '#fff' })
    expect(mocks.setTheme).toHaveBeenCalledExactlyOnceWith(ThemeMode.system)
  })
})
