import { type Client, createClient } from '@libsql/client'
import { DEFAULT_DSH_AGENT_ID, DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ unlocked: false, database: undefined as any }))
vi.mock('@main/services/dshPreview/access', () => ({
  assertDshPreviewUnlocked: () => {
    if (!state.unlocked)
      throw Object.assign(new Error('Internal testing is locked'), { code: 'internal_testing_locked', status: 403 })
  }
}))
vi.mock('@main/apiServer/services/models', () => ({ modelsService: {} }))
vi.mock('@main/services/RemoteModelPolicyService', () => ({ remoteModelPolicyService: {} }))
vi.mock('@main/services/ConfigManager', () => ({ configManager: { getLanguage: () => 'zh-CN' } }))
vi.mock('../automation/bridge', () => ({ invalidateAutomationSession: vi.fn() }))
vi.mock('../../BaseService', () => ({
  BaseService: class {
    async getDatabase() {
      return state.database
    }
    protected deserializeJsonFields(row: Record<string, unknown>) {
      const result = { ...row }
      for (const field of ['configuration', 'accessible_paths', 'mcps', 'allowed_tools', 'slash_commands']) {
        if (typeof result[field] === 'string') result[field] = JSON.parse(result[field])
      }
      return result
    }
    protected serializeJsonFields(row: Record<string, unknown>) {
      return Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value && typeof value === 'object' ? JSON.stringify(value) : value
        ])
      )
    }
    protected reconcileAccessiblePaths(paths: unknown) {
      return { paths, changed: false }
    }
    protected ensurePathsExist(paths: unknown) {
      return paths
    }
    protected async validateAgentModels() {}
    public async listMcpTools() {
      return { tools: [], legacyIdMap: new Map() }
    }
    protected normalizeAllowedTools() {
      return []
    }
  }
}))

import { agentsTable, sessionMessagesTable, sessionsTable } from '../../database/schema'
import { agentMessageRepository } from '../../database/sessionMessageRepository'
import { AgentService } from '../AgentService'
import { SessionService } from '../SessionService'

let client: Client
let agents: AgentService
let sessions: SessionService
const owners = [DEFAULT_OPENCODE_AGENT_ID, DEFAULT_DSH_AGENT_ID, 'legacy-agent']
const sessionId = (agentId: string) => `session-${agentId}`
const payload = (assistantId = DEFAULT_DSH_AGENT_ID) =>
  ({
    message: { id: 'user-message', role: 'user', assistantId, status: 'success', blocks: [] },
    blocks: []
  }) as any

beforeEach(async () => {
  state.unlocked = false
  client = createClient({ url: ':memory:' })
  state.database = drizzle(client)
  for (const table of [agentsTable, sessionsTable, sessionMessagesTable]) {
    const columns = Object.values(getTableColumns(table))
      .map((column) => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`)
      .join(', ')
    await client.execute(`CREATE TABLE "${getTableName(table)}" (${columns})`)
  }
  const now = new Date().toISOString()
  for (const id of owners) {
    await state.database.insert(agentsTable).values({
      id,
      type: 'claude-code',
      name: id,
      model: 'fixture:model',
      accessible_paths: '[]',
      created_at: now,
      updated_at: now
    })
    await state.database.insert(sessionsTable).values({
      id: sessionId(id),
      agent_id: id,
      agent_type: 'claude-code',
      name: `Shared query ${id}`,
      model: 'fixture:model',
      configuration: '{}',
      accessible_paths: '[]',
      slash_commands: '[]',
      created_at: now,
      updated_at: now
    })
  }
  agents = new AgentService()
  sessions = new SessionService()
  vi.spyOn(sessions, 'listSlashCommands').mockResolvedValue([])
})
afterEach(() => {
  client.close()
  vi.restoreAllMocks()
})

describe('DSH stored workspace isolation', () => {
  it.each(['list-agents', 'get-agent', 'list-sessions', 'get-session', 'create-session'])(
    'rejects locked %s without allowing a direct service bypass',
    async (action) => {
      const operations: Record<string, () => Promise<unknown>> = {
        'list-agents': () => agents.listAgents({ workspace: 'dsh' }),
        'get-agent': () => agents.getAgent(DEFAULT_DSH_AGENT_ID),
        'list-sessions': () => sessions.listSessions(undefined, { workspace: 'dsh' }),
        'get-session': () => sessions.getSession(DEFAULT_DSH_AGENT_ID, sessionId(DEFAULT_DSH_AGENT_ID)),
        'create-session': () => sessions.createSession(DEFAULT_DSH_AGENT_ID, { name: 'Locked create' })
      }
      await expect(operations[action]()).rejects.toMatchObject({ code: 'internal_testing_locked' })
      expect((await state.database.select().from(sessionsTable)).length).toBe(3)
    }
  )

  it.each(['history', 'user', 'assistant', 'exchange'])(
    'blocks locked IPC repository %s by stored owner even with a forged assistant ID',
    async (action) => {
      const id = sessionId(DEFAULT_DSH_AGENT_ID)
      const forged = payload(DEFAULT_OPENCODE_AGENT_ID)
      const operations: Record<string, () => Promise<unknown>> = {
        history: () => agentMessageRepository.getSessionHistory(id),
        user: () => agentMessageRepository.persistUserMessage({ sessionId: id, payload: forged }),
        assistant: () =>
          agentMessageRepository.persistAssistantMessage({ sessionId: id, agentSessionId: 'native', payload: forged }),
        exchange: () => agentMessageRepository.persistExchange({ sessionId: id, user: { payload: forged } })
      }
      await expect(operations[action]()).rejects.toMatchObject({ code: 'internal_testing_locked' })
      expect(await state.database.select().from(sessionMessagesTable)).toEqual([])
    }
  )

  it.each([undefined, 'legacy', 'opencode', 'dsh'] as const)(
    'filters actual SQLite agent and session lists for workspace %s',
    async (workspace) => {
      state.unlocked = true
      const expected =
        workspace === 'dsh'
          ? [DEFAULT_DSH_AGENT_ID]
          : workspace === 'opencode'
            ? [DEFAULT_OPENCODE_AGENT_ID]
            : workspace === 'legacy'
              ? ['legacy-agent']
              : [DEFAULT_OPENCODE_AGENT_ID, 'legacy-agent']
      const listedAgents = await agents.listAgents({ workspace })
      const listedSessions = await sessions.listSessions(undefined, { workspace })
      expect(listedAgents.agents.map((item) => item.id).sort()).toEqual(expected.toSorted())
      expect(listedAgents.total).toBe(expected.length)
      expect(listedSessions.sessions.map((item) => item.agent_id).sort()).toEqual(expected.toSorted())
      expect(listedSessions.total).toBe(expected.length)
      const searched = await sessions.searchSessions('Shared query', { workspace })
      expect(searched.results.map((item) => item.session.agent_id).sort()).toEqual(expected.toSorted())
      expect(searched.total).toBe(expected.length)
    }
  )

  it('keeps stored session lookup scoped to its owner after unlock', async () => {
    state.unlocked = true
    const id = sessionId(DEFAULT_DSH_AGENT_ID)
    expect(await sessions.getSession(DEFAULT_OPENCODE_AGENT_ID, id)).toBeNull()
    expect(await sessions.getSession('legacy-agent', id)).toBeNull()
    expect(await sessions.getSession(DEFAULT_DSH_AGENT_ID, sessionId(DEFAULT_OPENCODE_AGENT_ID))).toBeNull()
    expect(await sessions.getSession(DEFAULT_DSH_AGENT_ID, id)).toMatchObject({ id, agent_id: DEFAULT_DSH_AGENT_ID })
  })

  it('keeps ordinary history usable while locked and DSH history available only after unlock', async () => {
    const ordinary = sessionId(DEFAULT_OPENCODE_AGENT_ID)
    await agentMessageRepository.persistExchange({
      sessionId: ordinary,
      user: { payload: payload(DEFAULT_OPENCODE_AGENT_ID) }
    })
    expect(await agentMessageRepository.getSessionHistory(ordinary)).toHaveLength(1)
    state.unlocked = true
    const id = sessionId(DEFAULT_DSH_AGENT_ID)
    await agentMessageRepository.persistExchange({ sessionId: id, user: { payload: payload() } })
    expect(await agentMessageRepository.getSessionHistory(id)).toHaveLength(1)
    state.unlocked = false
    await expect(agentMessageRepository.getSessionHistory(id)).rejects.toMatchObject({
      code: 'internal_testing_locked'
    })
  })
})
