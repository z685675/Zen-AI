import { DSH_PREVIEW_IPC, DSH_PREVIEW_VERSION, type DshPreviewStatus } from '@shared/dshPreview'
import { type BrowserWindow, ipcMain } from 'electron'

import { assertDshPreviewUnlocked, isDshPreviewUnlocked, lockDshPreview, unlockDshPreview } from './access'
import { ensureDshPreviewAgent } from './builtin'
import { getDshPreviewRuntimeStatus, prepareDshPreviewRuntime, stopAllDshRuntimes } from './runtime'

export function registerDshPreviewIpc(mainWindow: BrowserWindow): void {
  const requireOwner = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('Invalid internal testing sender')
    }
  }
  const status = (): DshPreviewStatus =>
    isDshPreviewUnlocked()
      ? { ...getDshPreviewRuntimeStatus(), unlocked: true }
      : { unlocked: false, version: DSH_PREVIEW_VERSION, state: 'not-installed' }
  const changed = () => {
    const value = status()
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(DSH_PREVIEW_IPC.changed, value)
    return value
  }

  ipcMain.handle(DSH_PREVIEW_IPC.status, (event) => {
    requireOwner(event)
    return status()
  })
  ipcMain.handle(DSH_PREVIEW_IPC.unlock, (event, password: unknown) => {
    requireOwner(event)
    return { accepted: unlockDshPreview(password), status: changed() }
  })
  ipcMain.handle(DSH_PREVIEW_IPC.lock, async (event) => {
    requireOwner(event)
    lockDshPreview()
    changed()
    await stopAllDshRuntimes()
    return status()
  })
  ipcMain.handle(DSH_PREVIEW_IPC.prepare, async (event) => {
    requireOwner(event)
    assertDshPreviewUnlocked()
    try {
      await prepareDshPreviewRuntime()
      assertDshPreviewUnlocked()
      await ensureDshPreviewAgent()
      return changed()
    } finally {
      changed()
    }
  })
}
