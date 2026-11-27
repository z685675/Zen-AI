import { IpcChannel } from '@shared/IpcChannel'
import { ThemeMode } from '@types'
import { BrowserWindow, nativeTheme } from 'electron'

import { titleBarOverlayDark, titleBarOverlayLight } from '../config'
import { configManager } from './ConfigManager'

class ThemeService {
  constructor() {
    this.setTheme(configManager.getTheme())
    nativeTheme.on('updated', () => this.updateWindows())
  }

  private updateWindows() {
    const dark = nativeTheme.shouldUseDarkColors
    const overlay = dark ? titleBarOverlayDark : titleBarOverlayLight
    const theme = dark ? ThemeMode.dark : ThemeMode.light

    BrowserWindow.getAllWindows().forEach((win) => {
      if (win.isDestroyed()) return
      if (win.setTitleBarOverlay) {
        try {
          win.setTitleBarOverlay(overlay)
        } catch {
          // Ignore windows that do not support custom title bar overlays.
        }
      }
      win.webContents.send(IpcChannel.ThemeUpdated, theme)
    })
  }

  setTheme(theme: ThemeMode) {
    if (theme !== ThemeMode.light && theme !== ThemeMode.dark && theme !== ThemeMode.system) return
    nativeTheme.themeSource = theme
    configManager.setTheme(theme)
    this.updateWindows()
  }
}

export const themeService = new ThemeService()
