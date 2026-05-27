import { IpcChannel } from '@shared/IpcChannel'
import { ThemeMode } from '@types'
import { BrowserWindow, nativeTheme } from 'electron'

import { titleBarOverlayLight } from '../config'
import { configManager } from './ConfigManager'

class ThemeService {
  constructor() {
    this.setTheme(ThemeMode.light)
    nativeTheme.on('updated', this.themeUpdatadHandler.bind(this))
  }

  themeUpdatadHandler() {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (win && !win.isDestroyed() && win.setTitleBarOverlay) {
        try {
          win.setTitleBarOverlay(titleBarOverlayLight)
        } catch (error) {
          // Ignore windows that do not support custom title bar overlays.
        }
      }
      win.webContents.send(IpcChannel.ThemeUpdated, ThemeMode.light)
    })
  }

  setTheme(theme: ThemeMode) {
    const enforcedTheme = theme === ThemeMode.light ? theme : ThemeMode.light
    nativeTheme.themeSource = enforcedTheme
    configManager.setTheme(enforcedTheme)
    this.themeUpdatadHandler()
  }
}

export const themeService = new ThemeService()
