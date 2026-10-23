import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { CdpBrowserController } from './controller'
import { toolDefinitions, toolHandlers } from './tools'
import { logger } from './types'

const servers = new Set<BrowserServer>()
let shuttingDown = false

/** Await native session cleanup before Electron destroys its V8 environment. */
export async function shutdownBrowserServers(): Promise<void> {
  shuttingDown = true
  const results = await Promise.allSettled([...servers].map((server) => server.close()))
  const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
  if (errors.length) throw new AggregateError(errors, 'Browser tool shutdown failed')
}

export class BrowserServer {
  public mcpServer: McpServer
  private controller: CdpBrowserController
  private closing: Promise<void> | undefined

  /** Low-level Server instance (used by factory / InMemoryTransport) */
  public get server(): Server {
    return this.mcpServer.server
  }

  constructor() {
    if (shuttingDown) throw new Error('Browser tools are shutting down')
    this.controller = new CdpBrowserController()
    this.mcpServer = new McpServer(
      {
        name: '@cherry/browser',
        version: '0.1.0'
      },
      {
        capabilities: {
          resources: {},
          tools: {}
        }
      }
    )

    this.mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: toolDefinitions
      }
    })

    this.mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (this.closing) throw new Error('Browser tool session is closing')
      const { name, arguments: args } = request.params
      const handler = toolHandlers[name]
      if (!handler) {
        throw new Error('Tool not found')
      }
      return handler(this.controller, args)
    })

    servers.add(this)
    this.mcpServer.server.onclose = () => {
      void this.close().catch((error) => logger.warn('Failed to close browser tool session', { error }))
    }
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled([this.controller.dispose(), this.mcpServer.close?.()])
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Browser tool cleanup failed')
      servers.delete(this)
    })
    return this.closing
  }
}

export default BrowserServer
