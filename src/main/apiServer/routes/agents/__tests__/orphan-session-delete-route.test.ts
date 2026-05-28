import { type Server } from 'node:http'

import express from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sessionHandlers } from '../handlers'
import { agentsRoutes } from '../index'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })
  }
}))

vi.mock('../handlers', async () => {
  return {
    agentHandlers: {
      reorderAgents: vi.fn((_req, res) => res.status(200).json({ success: true })),
      createAgent: vi.fn((_req, res) => res.status(201).json({})),
      listAgents: vi.fn((_req, res) => res.status(200).json({ data: [] })),
      getAgent: vi.fn((_req, res) => res.status(200).json({})),
      updateAgent: vi.fn((_req, res) => res.status(200).json({})),
      patchAgent: vi.fn((_req, res) => res.status(200).json({})),
      deleteAgent: vi.fn((_req, res) => res.status(204).send())
    },
    sessionHandlers: {
      searchAllSessions: vi.fn((_req, res) => res.status(200).json({ data: [] })),
      listAllSessions: vi.fn((_req, res) => res.status(200).json({ data: [] })),
      reorderSessions: vi.fn((_req, res) => res.status(200).json({ success: true })),
      createSession: vi.fn((_req, res) => res.status(201).json({})),
      listSessions: vi.fn((_req, res) => res.status(200).json({ data: [] })),
      getSession: vi.fn((_req, res) => res.status(200).json({})),
      updateSession: vi.fn((_req, res) => res.status(200).json({})),
      patchSession: vi.fn((_req, res) => res.status(200).json({})),
      deleteSession: vi.fn((_req, res) => res.status(204).send())
    },
    messageHandlers: {
      createMessage: vi.fn((_req, res) => res.status(201).json({})),
      deleteMessage: vi.fn((_req, res) => res.status(204).send())
    }
  }
})

vi.mock('../middleware', () => ({
  checkAgentExists: vi.fn((_req, res) =>
    res.status(418).json({
      error: {
        message: 'checkAgentExists should not run for orphan session deletion',
        type: 'test_error',
        code: 'unexpected_agent_check'
      }
    })
  ),
  handleValidationErrors: vi.fn((_req, _res, next) => next())
}))

const createApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/agents', agentsRoutes)
  return app
}

const withServer = async (app: express.Express, run: (baseUrl: string) => Promise<void>) => {
  let server: Server | undefined
  try {
    server = await new Promise<Server>((resolve) => {
      const listeningServer = app.listen(0, () => resolve(listeningServer))
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve test server address')
    }
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
}

describe('agents routes orphan session deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('routes DELETE session requests directly to the delete handler even when the agent no longer exists', async () => {
    await withServer(createApp(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/agents/deleted-agent/sessions/session-old`, { method: 'DELETE' })

      expect(response.status).toBe(204)
      expect(sessionHandlers.deleteSession).toHaveBeenCalledTimes(1)
    })
  })
})
