import { createServer } from 'node:http'

import { loggerService } from '@logger'
import { IpcChannel } from '@shared/IpcChannel'

import { windowService } from '../services/WindowService'
import { app } from './app'
import { config } from './config'

const logger = loggerService.withContext('ApiServer')

const GLOBAL_REQUEST_TIMEOUT_MS = 5 * 60_000
const GLOBAL_HEADERS_TIMEOUT_MS = GLOBAL_REQUEST_TIMEOUT_MS + 5_000
const GLOBAL_KEEPALIVE_TIMEOUT_MS = 60_000

export class ApiServer {
  private server: ReturnType<typeof createServer> | null = null
  private transition: Promise<void> = Promise.resolve()

  private exclusive(operation: () => Promise<void>): Promise<void> {
    const pending = this.transition.then(operation)
    // A failed bind must not poison subsequent explicit start/stop requests.
    this.transition = pending.catch(() => {})
    return pending
  }

  async start(): Promise<void> {
    return this.exclusive(() => this.startInternal())
  }

  private async startInternal(): Promise<void> {
    if (this.server && this.server.listening) {
      logger.warn('Server already running')
      return
    }

    // Clean up any failed server instance
    if (this.server && !this.server.listening) {
      logger.warn('Cleaning up failed server instance')
      this.server = null
    }

    // Load config
    const { port, host } = await config.load()

    // Create server with Express app
    const server = createServer(app)
    this.server = server
    this.applyServerTimeouts(server)

    // Start server
    return new Promise((resolve, reject) => {
      server.listen(port, host, () => {
        logger.info('API server started', { host, port })

        // Notify renderer that API server is ready
        const mainWindow = windowService.getMainWindow()
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IpcChannel.ApiServer_Ready)
        }

        resolve()
      })

      server.on('error', (error) => {
        // Clean up the server instance if listen fails
        if (!server.listening && this.server === server) this.server = null
        reject(error)
      })
    })
  }

  private applyServerTimeouts(server: ReturnType<typeof createServer>): void {
    server.requestTimeout = GLOBAL_REQUEST_TIMEOUT_MS
    server.headersTimeout = Math.max(GLOBAL_HEADERS_TIMEOUT_MS, server.requestTimeout + 1_000)
    server.keepAliveTimeout = GLOBAL_KEEPALIVE_TIMEOUT_MS
    server.setTimeout(0)
  }

  async stop(): Promise<void> {
    return this.exclusive(() => this.stopInternal())
  }

  private async stopInternal(): Promise<void> {
    const server = this.server
    if (!server) return

    return new Promise((resolve) => {
      server.close(() => {
        logger.info('API server stopped')
        if (this.server === server) this.server = null
        resolve()
      })
    })
  }

  async restart(): Promise<void> {
    return this.exclusive(async () => {
      await this.stopInternal()
      await config.reload()
      await this.startInternal()
    })
  }

  isRunning(): boolean {
    const hasServer = this.server !== null
    const isListening = this.server?.listening || false
    const result = hasServer && isListening

    logger.debug('isRunning check', { hasServer, isListening, result })

    return result
  }
}

export const apiServer = new ApiServer()
