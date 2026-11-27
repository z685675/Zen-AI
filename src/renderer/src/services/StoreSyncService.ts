import { loggerService } from '@logger'
import type { Middleware } from '@reduxjs/toolkit'
import { IpcChannel } from '@shared/IpcChannel'
import type { StoreSyncAction } from '@types'

const logger = loggerService.withContext('StoreSyncService')

type SyncOptions = {
  syncList: string[]
}

/**
 * StoreSyncService class manages Redux store synchronization between multiple windows
 * It uses singleton pattern to ensure only one sync service instance exists in the application
 *
 * Main features:
 * 1. Synchronizes Redux actions between windows via IPC
 * 2. Provides Redux middleware to intercept and broadcast actions that need syncing
 * 3. Supports whitelist configuration for action types to sync
 * 4. Handles window subscription and unsubscription logic
 */
export class StoreSyncService {
  private static instance: StoreSyncService
  private options: SyncOptions = {
    syncList: []
  }
  private broadcastSyncRemover: (() => void) | null = null
  private subscription?: Promise<void>
  private rehydrated = false
  private pendingActions: StoreSyncAction[] = []

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

  /**
   * Set sync options
   * @param options Partial sync options
   */
  public setOptions(options: Partial<SyncOptions>): void {
    this.options = { ...this.options, ...options }
  }

  /**
   * Create Redux middleware to intercept and broadcast actions
   * Actions will not be broadcasted if they are not in whitelist or come from sync
   */
  public createMiddleware(): Middleware {
    return () => (next) => (action) => {
      // Process the action normally first
      const result = next(action)

      // Check if this action came from sync or is a whitelisted action
      const syncAction = action as StoreSyncAction
      if (
        typeof syncAction?.type === 'string' &&
        !syncAction.meta?.fromSync &&
        this.shouldSyncAction(syncAction.type)
      ) {
        // Send to main process for broadcasting to other windows using the preload API
        if (window.api?.storeSync) {
          void window.api.storeSync.onUpdate(syncAction)
        }
      }

      return result
    }
  }

  /**
   * Check if action type is in whitelist
   * @param actionType Action type to check
   * @returns Whether the action should be synced
   */
  private shouldSyncAction(actionType: string): boolean {
    // If no whitelist is specified, sync nothing
    if (!this.options.syncList.length) {
      return false
    }

    // Check if the action belongs to a store slice we want to sync
    return this.options.syncList.some((prefix) => {
      return actionType.startsWith(prefix)
    })
  }

  /**
   * Subscribe to sync service
   * Attach before rehydration so incoming actions can be replayed over the stored snapshot.
   */
  public subscribe(): void {
    if (this.subscription || !window.api?.storeSync || !window.electron?.ipcRenderer) return

    this.broadcastSyncRemover = window.electron.ipcRenderer.on(
      IpcChannel.StoreSync_BroadcastSync,
      (_, action: StoreSyncAction) => {
        if (this.rehydrated) this.dispatchSynced(action)
        else this.pendingActions.push(action)
      }
    )

    this.subscription = Promise.resolve(window.api.storeSync.subscribe())
      .then((replay: StoreSyncAction[]) => {
        if (!Array.isArray(replay)) return
        if (this.rehydrated) replay.forEach((action) => this.dispatchSynced(action))
        else this.pendingActions = [...replay, ...this.pendingActions]
      })
      .catch((error: Error) => logger.error('Error subscribing to store sync:', error))
  }

  public async finishRehydration(): Promise<void> {
    await this.subscription
    this.rehydrated = true
    for (const action of this.pendingActions.splice(0)) this.dispatchSynced(action)
  }

  private dispatchSynced(action: StoreSyncAction): void {
    try {
      window.store.dispatch(action)
    } catch (error) {
      logger.error('Error dispatching synced action:', error as Error)
    }
  }

  /**
   * Unsubscribe from sync service
   * Cleans up IPC listener and related resources
   */
  public unsubscribe(): void {
    if (window.api?.storeSync) {
      void window.api.storeSync.unsubscribe()
    }

    if (this.broadcastSyncRemover) {
      this.broadcastSyncRemover()
      this.broadcastSyncRemover = null
    }
    this.subscription = undefined
  }
}

// Export singleton instance
export default StoreSyncService.getInstance()
