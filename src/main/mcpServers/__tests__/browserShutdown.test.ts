import { app } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  controllers: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
  servers: [] as Array<{ server: { onclose?: () => void }; close: ReturnType<typeof vi.fn> }>
}))
vi.mock('electron', () => ({ app: { on: vi.fn() } }))
vi.mock('../browser/controller', () => ({
  CdpBrowserController: class {
    dispose = vi.fn(async () => {})
    constructor() {
      harness.controllers.push(this)
    }
  }
}))
vi.mock('../browser/tools', () => ({ toolDefinitions: [], toolHandlers: {} }))
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    server = { setRequestHandler: vi.fn(), onclose: undefined as (() => void) | undefined }
    close = vi.fn(async () => this.server.onclose?.())
    constructor() {
      harness.servers.push(this)
    }
  }
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.controllers.length = 0
  harness.servers.length = 0
})

describe('browser native session shutdown', () => {
  it('closes a server once without leaving a per-instance quit listener', async () => {
    const { BrowserServer, shutdownBrowserServers } = await import('../browser/server')
    const server = new BrowserServer()
    expect(app.on).not.toHaveBeenCalled()
    const closing = server.close()
    expect(server.close()).toBe(closing)
    await closing
    await shutdownBrowserServers()
    expect(harness.controllers[0].dispose).toHaveBeenCalledOnce()
    expect(harness.servers[0].close).toHaveBeenCalledOnce()
  })

  it('waits for a native cleanup already started by transport cancellation', async () => {
    const { BrowserServer, shutdownBrowserServers } = await import('../browser/server')
    new BrowserServer()
    let release!: () => void
    harness.controllers[0].dispose.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
    harness.servers[0].server.onclose!()
    let complete = false
    const closing = shutdownBrowserServers().then(() => (complete = true))
    await Promise.resolve()
    expect(complete).toBe(false)
    release()
    await closing
    expect(complete).toBe(true)
    expect(harness.controllers[0].dispose).toHaveBeenCalledOnce()
  })

  it('preserves cleanup failure and stops every other server', async () => {
    const { BrowserServer, shutdownBrowserServers } = await import('../browser/server')
    new BrowserServer()
    new BrowserServer()
    harness.controllers[0].dispose.mockRejectedValue(new Error('native storage cleanup failed'))
    await expect(shutdownBrowserServers()).rejects.toThrow('Browser tool shutdown failed')
    await expect(shutdownBrowserServers()).rejects.toThrow('Browser tool shutdown failed')
    expect(harness.controllers[1].dispose).toHaveBeenCalledOnce()
    expect(harness.servers[0].close).toHaveBeenCalledOnce()
    expect(harness.servers[1].close).toHaveBeenCalledOnce()
  })

  it('refuses late browser instances once application shutdown starts', async () => {
    const { BrowserServer, shutdownBrowserServers } = await import('../browser/server')
    await shutdownBrowserServers()
    expect(() => new BrowserServer()).toThrow('Browser tools are shutting down')
    expect(harness.controllers).toHaveLength(0)
  })
})
