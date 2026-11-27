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
import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'
import { type BrowserWindow, ipcMain, type WebContents } from 'electron'

import { CacheService } from './CacheService'

type StoreValue = any

const logger = loggerService.withContext('ReduxService')
const STORE_READY_TIMEOUT = 10000
const PROVIDERS_CACHE_KEY = 'api-server:providers'
const PROVIDER_CACHE_INVALIDATION_ACTIONS = new Set([
  'llm/updateProvider',
  'llm/updateProviders',
  'llm/addProvider',
  'llm/removeProvider',
  'llm/addModel',
  'llm/removeModel'
])

export const invalidateApiServerProvidersCacheForAction = (actionType: string): void => {
  if (PROVIDER_CACHE_INVALIDATION_ACTIONS.has(actionType)) {
    CacheService.remove(PROVIDERS_CACHE_KEY)
  }
}

export class ReduxService {
  private contents?: WebContents
  private isReady = false
  private readiness = Promise.withResolvers<void>()

  constructor() {
    ipcMain.handle(IpcChannel.ReduxStoreReady, (event) => {
      if (event.sender !== this.contents || event.senderFrame !== event.sender.mainFrame || this.isReady) return
      this.isReady = true
      this.readiness.resolve()
    })
  }

  bindWindow(window: BrowserWindow): void {
    const contents = window.webContents
    if (this.contents === contents) return
    this.resetReadiness()
    this.contents = contents

    const reset = () => {
      if (this.contents === contents) this.resetReadiness()
    }
    contents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) reset()
    })
    contents.on('render-process-gone', reset)
    contents.once('destroyed', () => {
      if (this.contents !== contents) return
      reset()
      this.contents = undefined
    })
  }

  private resetReadiness(): void {
    if (!this.isReady) return
    this.isReady = false
    this.readiness = Promise.withResolvers<void>()
  }

  async waitUntilReady(): Promise<void> {
    while (!this.isReady) await this.readiness.promise
  }

  private async getWebContents(): Promise<WebContents> {
    if (!this.isReady) {
      let timer: ReturnType<typeof setTimeout>
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timeout waiting for Redux store to be ready')), STORE_READY_TIMEOUT)
      })
      await Promise.race([this.waitUntilReady(), timeout]).finally(() => clearTimeout(timer))
    }

    if (!this.isReady || !this.contents || this.contents.isDestroyed()) {
      throw new Error('Main window is not available')
    }
    return this.contents
  }

  // Select state from renderer process
  async select<T = StoreValue>(selector: string): Promise<T> {
    try {
      const webContents = await this.getWebContents()
      return await webContents.executeJavaScript(`
        (() => {
          const state = window.store.getState();
          return ${selector};
        })()
      `)
    } catch (error) {
      logger.error('Failed to select store value:', error as Error)
      throw error
    }
  }

  // Dispatch action
  async dispatch(action: any): Promise<void> {
    try {
      const webContents = await this.getWebContents()
      await webContents.executeJavaScript(`window.store.dispatch(${JSON.stringify(action)})`)
      if (action?.type && typeof action.type === 'string') {
        invalidateApiServerProvidersCacheForAction(action.type)
      }
    } catch (error) {
      logger.error('Failed to dispatch action:', error as Error)
      throw error
    }
  }

  // Get entire state tree
  async getState(): Promise<any> {
    try {
      const webContents = await this.getWebContents()
      return await webContents.executeJavaScript(`window.store.getState()`)
    } catch (error) {
      logger.error('Failed to get state:', error as Error)
      throw error
    }
  }

  // Batch dispatch actions
  async batch(actions: any[]): Promise<void> {
    for (const action of actions) {
      await this.dispatch(action)
    }
  }
}

export const reduxService = new ReduxService()

/**
 * @example
 * async function example() {
 *   try {
 *     // Select state
 *     const settings = await reduxService.select('state.settings')
 *     logger.log('settings', settings)
 *
 *     // Dispatch action
 *     await reduxService.dispatch({
 *       type: 'settings/updateApiKey',
 *       payload: 'new-api-key'
 *     })
 *
 *     // Batch dispatch actions
 *     await reduxService.batch([
 *       { type: 'action1', payload: 'data1' },
 *       { type: 'action2', payload: 'data2' }
 *     ])
 *   } catch (error) {
 *     logger.error('Error:', error)
 *   }
 * }
 */
