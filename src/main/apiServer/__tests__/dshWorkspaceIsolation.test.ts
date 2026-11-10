import type { Server } from 'node:http'

import { DEFAULT_DSH_AGENT_ID, DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ unlocked: false, ensureDsh: vi.fn(), ensureOpenCode: vi.fn() }))
vi.mock('@main/services/dshPreview/access', () => ({
  assertDshPreviewUnlocked: () => {
    if (!state.unlocked)
      throw Object.assign(new Error('Internal testing is locked'), { code: 'internal_testing_locked', status: 403 })
  }
}))
vi.mock('@main/services/dshPreview/builtin', () => ({ ensureDshPreviewAgent: state.ensureDsh }))
vi.mock('@main/services/agents/services/opencode/builtin', () => ({ ensureOpenCodeAgent: state.ensureOpenCode }))
vi.mock('@main/services/LoggerService', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}))
vi.mock('../middleware/auth', () => ({ authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }))
vi.mock('../middleware/openapi', () => ({ setupOpenAPIDocumentation: vi.fn() }))

// Exercise the real application mounts and workspace middleware without
// creating sessions, preparing runtimes or sending any model requests.
vi.mock('../routes/agents', async () => {
  const { Router } = await import('express')
  const router = Router()
  router.use((req, res) => res.json({ workspace: res.locals.agentWorkspace ?? 'legacy', path: req.path }))
  return { agentsRoutes: router }
})
vi.mock('../routes/assistant-mcp', async () => ({ assistantMcpRoutes: (await import('express')).Router() }))
vi.mock('../routes/browser-mcp', async () => ({ browserMcpRoutes: (await import('express')).Router() }))
vi.mock('../routes/channels', async () => ({ channelsRouter: (await import('express')).Router() }))
vi.mock('../routes/chat', async () => ({ chatRoutes: (await import('express')).Router() }))
vi.mock('../routes/claw-mcp', async () => ({ clawMcpRoutes: (await import('express')).Router() }))
vi.mock('../routes/knowledge', async () => ({ knowledgeRoutes: (await import('express')).Router() }))
vi.mock('../routes/mcp', async () => ({ mcpRoutes: (await import('express')).Router() }))
vi.mock('../routes/messages', async () => {
  const { Router } = await import('express')
  return { messagesRoutes: Router(), messagesProviderRoutes: Router() }
})
vi.mock('../routes/models', async () => ({ modelsRoutes: (await import('express')).Router() }))
vi.mock('../routes/tasks', async () => ({ tasksRouter: (await import('express')).Router() }))

import { app } from '../app'

let server: Server
let baseUrl: string
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
})
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})
beforeEach(() => {
  state.unlocked = false
  state.ensureDsh.mockClear()
  state.ensureOpenCode.mockClear()
})

describe('DSH preview API workspace boundary', () => {
  it.each([
    ['GET', ''],
    ['GET', `/${DEFAULT_DSH_AGENT_ID}`],
    ['GET', '/sessions'],
    ['GET', `/${DEFAULT_DSH_AGENT_ID}/sessions/session-dsh`],
    ['POST', `/${DEFAULT_DSH_AGENT_ID}/sessions`],
    ['POST', `/${DEFAULT_DSH_AGENT_ID}/sessions/session-dsh/messages`]
  ])('rejects locked %s %s before any workspace handler or provisioning', async (method, suffix) => {
    const response = await fetch(`${baseUrl}/dsh-preview/agents${suffix}`, { method })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'internal_testing_locked' } })
    expect(state.ensureDsh).not.toHaveBeenCalled()
  })

  it.each([
    ['GET', ''],
    ['GET', '/sessions'],
    ['GET', `/${DEFAULT_DSH_AGENT_ID}/sessions/session-dsh`],
    ['POST', `/${DEFAULT_DSH_AGENT_ID}/sessions`],
    ['POST', `/${DEFAULT_DSH_AGENT_ID}/sessions/session-dsh/messages`]
  ])('routes unlocked %s %s only into the DSH workspace', async (method, suffix) => {
    state.unlocked = true
    const response = await fetch(`${baseUrl}/dsh-preview/agents${suffix}`, { method })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ workspace: 'dsh' })
    expect(state.ensureOpenCode).not.toHaveBeenCalled()
    expect(state.ensureDsh).toHaveBeenCalledTimes(suffix === '' ? 1 : 0)
  })

  it.each([
    `/agents/${DEFAULT_DSH_AGENT_ID}`,
    `/agents/${DEFAULT_DSH_AGENT_ID}/sessions/session-dsh/messages`,
    '/agents/%7Aen-dsh-preview-default',
    '/agents/%7Aen-dsh-preview-default/sessions/session-dsh/messages',
    `/new-assistant/agents/${DEFAULT_DSH_AGENT_ID}`,
    `/new-assistant/agents/${DEFAULT_DSH_AGENT_ID}/sessions/session-dsh/messages`,
    `/dsh-preview/agents/${DEFAULT_OPENCODE_AGENT_ID}`,
    `/dsh-preview/agents/${DEFAULT_OPENCODE_AGENT_ID}/sessions/session-opencode/messages`,
    '/dsh-preview/agents/legacy-agent/sessions/session-legacy'
  ])('keeps other assistant paths isolated after unlock: %s', async (route) => {
    state.unlocked = true
    const response = await fetch(`${baseUrl}${route}`)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'workspace_mismatch' } })
    expect(state.ensureDsh).not.toHaveBeenCalled()
  })

  it('keeps the DSH agent managed after unlock', async () => {
    state.unlocked = true
    const response = await fetch(`${baseUrl}/dsh-preview/agents`, { method: 'POST' })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'managed_agent' } })
  })
})
