/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import { IpcChannel } from '@shared/IpcChannel'
import type { StoreSyncAction } from '@types'
import { BrowserWindow, ipcMain } from 'electron'

/**
 * StoreSyncService class manages Redux store synchronization between multiple windows in the main process
 * It uses singleton pattern to ensure only one sync service instance exists in the application
 *
 * Main features:
 * 1. Manages window subscriptions for store sync
 * 2. Handles IPC communication for store sync between windows
 * 3. Broadcasts Redux actions from one window to all other windows
 * 4. Adds metadata to synced actions to prevent infinite sync loops
 */
export class StoreSyncService {
  private static instance: StoreSyncService
  private windowIds = new Set<number>()
  private watchedWindows = new WeakSet<BrowserWindow>()
  private mainWindow: BrowserWindow | null = null
  private pendingMainActions: StoreSyncAction[] = []
  private isIpcHandlerRegistered = false

  private constructor() {
    return
  }

  /**
   * Get the singleton instance of StoreSyncService
   */
  public static getInstance(): StoreSyncService {
    if (!StoreSyncService.instance) {
      StoreSyncService.instance = new StoreSyncService()
    }
    return StoreSyncService.instance
  }

  private subscribe(window: BrowserWindow): StoreSyncAction[] {
    this.watchWindow(window)
    this.windowIds.add(window.id)
    return this.mainWindow === window ? this.pendingMainActions.splice(0) : []
  }

  private watchWindow(window: BrowserWindow): void {
    if (this.watchedWindows.has(window)) return
    this.watchedWindows.add(window)
    const id = window.id
    const reset = () => this.windowIds.delete(id)
    window.webContents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) reset()
    })
    window.webContents.on('render-process-gone', reset)
    window.once('closed', () => {
      reset()
      if (this.mainWindow === window) this.mainWindow = null
    })
  }

  public bindMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
    this.watchWindow(window)
  }

  /**
   * Sync an action to all renderer windows
   * @param type Action type, like 'settings/setTray'
   * @param payload Action payload
   *
   * NOTICE: DO NOT use directly in ConfigManager, may cause infinite sync loop
   */
  public syncToRenderer(type: string, payload: any): void {
    const action: StoreSyncAction = {
      type,
      payload
    }

    //-1 means the action is from the main process, will be broadcast to all windows
    this.broadcastToOtherWindows(-1, action)
  }

  /**
   * Register IPC handlers for store sync communication
   * Handles window subscription, unsubscription and action broadcasting
   */
  public registerIpcHandler(): void {
    if (this.isIpcHandlerRegistered) return

    const getSenderWindow = (event: Electron.IpcMainInvokeEvent) => {
      if (event.senderFrame !== event.sender.mainFrame) return null
      const window = BrowserWindow.fromWebContents(event.sender)
      return window?.webContents === event.sender ? window : null
    }

    ipcMain.handle(IpcChannel.StoreSync_Subscribe, (event) => {
      const window = getSenderWindow(event)
      return window ? this.subscribe(window) : []
    })

    ipcMain.handle(IpcChannel.StoreSync_Unsubscribe, (event) => {
      const windowId = getSenderWindow(event)?.id
      if (windowId) {
        this.windowIds.delete(windowId)
      }
    })

    ipcMain.handle(IpcChannel.StoreSync_OnUpdate, (event, action: StoreSyncAction) => {
      const sourceWindowId = getSenderWindow(event)?.id
      if (!sourceWindowId || typeof action?.type !== 'string' || action.meta?.fromSync) return

      // Broadcast the action to all other windows
      this.broadcastToOtherWindows(sourceWindowId, action)
    })

    this.isIpcHandlerRegistered = true
  }

  /**
   * Broadcast a Redux action to all other windows except the source
   * @param sourceWindowId ID of the window that originated the action
   * @param action Redux action to broadcast
   */
  private broadcastToOtherWindows(sourceWindowId: number, action: StoreSyncAction): void {
    // Add metadata to indicate this action came from sync
    const syncAction = {
      ...action,
      meta: {
        ...action.meta,
        fromSync: true,
        source: `windowId:${sourceWindowId}`
      }
    }

    // Retain changes from secondary renderers while the persistence owner is unavailable.
    if (!this.mainWindow || (sourceWindowId !== this.mainWindow.id && !this.windowIds.has(this.mainWindow.id))) {
      this.pendingMainActions.push(syncAction)
    }

    this.windowIds.forEach((windowId) => {
      if (windowId !== sourceWindowId) {
        const targetWindow = BrowserWindow.fromId(windowId)
        if (targetWindow && !targetWindow.isDestroyed()) {
          targetWindow.webContents.send(IpcChannel.StoreSync_BroadcastSync, syncAction)
        } else {
          this.windowIds.delete(windowId)
        }
      }
    })
  }
}

// Export singleton instance
export default StoreSyncService.getInstance()
