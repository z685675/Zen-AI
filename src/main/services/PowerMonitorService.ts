import { createRequire } from 'node:module'

import { loggerService } from '@logger'
import { isLinux, isMac, isWin } from '@main/constant'
import { BrowserWindow } from 'electron'
import { powerMonitor } from 'electron'

const logger = loggerService.withContext('PowerMonitorService')
const require = createRequire(import.meta.url)

type ElectronShutdownHandlerModule = {
  setWindowHandle: (handle: Buffer) => void
  on: (event: 'shutdown', listener: () => void | Promise<void>) => void
  releaseShutdown: () => boolean
}

let electronShutdownHandler: ElectronShutdownHandlerModule | null = null

if (isWin) {
  try {
    const module = require('@paymoapp/electron-shutdown-handler')
    electronShutdownHandler = (module.default || module) as ElectronShutdownHandlerModule
  } catch (error) {
    logger.warn('Windows shutdown handler native module unavailable, falling back to standard power monitor', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

type ShutdownHandler = () => void | Promise<void>

export class PowerMonitorService {
  private static instance: PowerMonitorService
  private initialized = false
  private shutdownHandlers: ShutdownHandler[] = []

  private constructor() {
    // Private constructor to prevent direct instantiation
  }

  public static getInstance(): PowerMonitorService {
    if (!PowerMonitorService.instance) {
      PowerMonitorService.instance = new PowerMonitorService()
    }
    return PowerMonitorService.instance
  }

  /**
   * Register a shutdown handler to be called when system shutdown is detected
   * @param handler - The handler function to be called on shutdown
   */
  public registerShutdownHandler(handler: ShutdownHandler): void {
    this.shutdownHandlers.push(handler)
    logger.info('Shutdown handler registered', { totalHandlers: this.shutdownHandlers.length })
  }

  /**
   * Initialize power monitor to listen for shutdown events
   */
  public init(): void {
    if (this.initialized) {
      logger.warn('PowerMonitorService already initialized')
      return
    }

    if (isWin) {
      this.initWindowsShutdownHandler()
    } else if (isMac || isLinux) {
      this.initElectronPowerMonitor()
    }

    this.initialized = true
    logger.info('PowerMonitorService initialized', { platform: process.platform })
  }

  /**
   * Execute all registered shutdown handlers
   */
  private async executeShutdownHandlers(): Promise<void> {
    logger.info('Executing shutdown handlers', { count: this.shutdownHandlers.length })
    for (const handler of this.shutdownHandlers) {
      try {
        await handler()
      } catch (error) {
        logger.error('Error executing shutdown handler', error as Error)
      }
    }
  }

  /**
   * Initialize shutdown handler for Windows using @paymoapp/electron-shutdown-handler
   */
  private initWindowsShutdownHandler(): void {
    if (!electronShutdownHandler) {
      logger.warn('Skipping native Windows shutdown handler because addon is unavailable')
      this.initElectronPowerMonitor()
      return
    }

    try {
      const zeroMemoryWindow = new BrowserWindow({ show: false })
      // Set the window handle for the shutdown handler
      electronShutdownHandler.setWindowHandle(zeroMemoryWindow.getNativeWindowHandle())

      // Listen for shutdown event
      electronShutdownHandler.on('shutdown', async () => {
        logger.info('System shutdown event detected (Windows)')
        // Execute all registered shutdown handlers
        await this.executeShutdownHandlers()
        // Release the shutdown block to allow the system to shut down
        electronShutdownHandler?.releaseShutdown()
      })

      logger.info('Windows shutdown handler registered')
    } catch (error) {
      logger.error('Failed to initialize Windows shutdown handler', error as Error)
    }
  }

  /**
   * Initialize power monitor for macOS and Linux using Electron's powerMonitor
   */
  private initElectronPowerMonitor(): void {
    try {
      powerMonitor.on('shutdown', async () => {
        logger.info('System shutdown event detected', { platform: process.platform })
        // Execute all registered shutdown handlers
        await this.executeShutdownHandlers()
      })

      logger.info('Electron powerMonitor shutdown listener registered')
    } catch (error) {
      logger.error('Failed to initialize Electron powerMonitor', error as Error)
    }
  }
}

// Default export as singleton instance
export default PowerMonitorService.getInstance()
