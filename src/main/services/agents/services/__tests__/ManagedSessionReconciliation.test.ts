import fs from 'node:fs/promises'
import path from 'node:path'

import { type Client, createClient } from '@libsql/client'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { DEFAULT_MODEL_POLICY } from '@shared/config/modelPolicy'
import { drizzle } from 'drizzle-orm/libsql'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: undefined as any,
  inventory: vi.fn(),
  records: {} as Record<string, unknown>,
  snapshot: {} as any,
  broadcast: vi.fn()
}))
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:path')
vi.mock('../../BaseService', () => ({
  BaseService: class {
    getDatabase() {
      return Promise.resolve(mocks.db)
    }
    deserializeJsonFields(row: any) {
      return {
        ...row,
        configuration: typeof row.configuration === 'string' ? JSON.parse(row.configuration) : row.configuration
      }
    }
    serializeJsonFields(row: any) {
      return { ...row, configuration: row.configuration ? JSON.stringify(row.configuration) : null }
    }
    async validateAgentModels() {}
    ensurePathsExist(value: unknown) {
      return value
    }
  }
}))
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: () => structuredClone(mocks.records),
    set: (_key: string, value: any) => {
      mocks.records = structuredClone(value)
    },
    getEnableDeveloperMode: () => false
  }
}))
vi.mock('@main/services/ModelAvailabilityService', () => ({ getCachedModelAvailability: () => ({}) }))
vi.mock('@main/services/RemoteModelPolicyService', () => ({
  remoteModelPolicyService: { getSnapshot: () => mocks.snapshot }
}))
vi.mock('../managedModelRecovery', async (original) => ({
  ...(await original<object>()),
  getManagedRecoveryInventory: mocks.inventory
}))
vi.mock('../channels/sessionStreamIpc', () => ({ broadcastSessionChanged: mocks.broadcast }))

import * as schema from '../../database/schema'
import { forgetSessionModelIntent, inheritModelPreference } from '../managedModelRecovery'
import { acquireSessionActivity } from '../sessionActivity'
import { SessionService } from '../SessionService'

describe('SQLite model reconciliation at idle boundaries', () => {
  let client: Client
  let service: SessionService
  const supply = (...ids: string[]) => ({
    models: ids.map((id) => ({ id: `zen:${id}`, provider: 'zen', provider_model_id: id, name: id })),
    providers: [{ id: 'zen', enabled: true, apiHost: 'https://zenai.925636.xyz' }]
  })
  const row = async (id: string) =>
    (await client.execute({ sql: 'SELECT model,plan_model,small_model FROM sessions WHERE id=?', args: [id] })).rows[0]
  beforeEach(async () => {
    client = createClient({ url: 'file::memory:?cache=shared' })
    await client.execute('PRAGMA foreign_keys=OFF')
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    for (const row of tables.rows) await client.execute(`DROP TABLE "${String(row.name).replaceAll('"', '""')}"`)
    for (const file of (await fs.readdir('resources/database/drizzle')).filter((name) => name.endsWith('.sql')).sort())
      await client.executeMultiple(await fs.readFile(path.join('resources/database/drizzle', file), 'utf8'))
    mocks.db = drizzle(client, { schema })
    mocks.records = {}
    mocks.inventory.mockReset()
    mocks.broadcast.mockClear()
    mocks.snapshot = {
      source: 'remote',
      version: 1,
      policy: {
        ...DEFAULT_MODEL_POLICY,
        version: 1,
        assistant: { ...DEFAULT_MODEL_POLICY.assistant, fallbackModels: ['B', 'C'] },
        defaults: { ...DEFAULT_MODEL_POLICY.defaults, assistantNewSession: 'A' }
      }
    }
    await client.execute({
      sql: "INSERT INTO agents(id,type,name,model,created_at,updated_at) VALUES(?, 'claude-code','test','zen:A','now','now')",
      args: [DEFAULT_OPENCODE_AGENT_ID]
    })
    await mocks.db.insert(schema.sessionsTable).values({
      id: 'session',
      name: 'Test session',
      agent_id: DEFAULT_OPENCODE_AGENT_ID,
      agent_type: 'claude-code',
      model: 'zen:A',
      plan_model: 'zen:A',
      small_model: 'zen:A',
      created_at: 'now',
      updated_at: 'now'
    })
    service = new SessionService()
    vi.spyOn(Date, 'now').mockReturnValue(1000)
  })
  afterEach(() => client.close())
  it('does not rewrite an active session, then repairs every model field and recovers after stability', async () => {
    mocks.inventory.mockResolvedValue(supply('B'))
    const release = acquireSessionActivity('session', 'run')
    try {
      await service.reconcileManagedModels()
      expect((await row('session')).model).toBe('zen:A')
    } finally {
      release()
    }
    await service.reconcileManagedModels()
    expect(await row('session')).toMatchObject({ model: 'zen:B', plan_model: 'zen:B', small_model: 'zen:B' })
    mocks.inventory.mockResolvedValue(supply('A', 'B'))
    await service.reconcileManagedModels()
    expect((await row('session')).model).toBe('zen:B')
    vi.mocked(Date.now).mockReturnValue(300_999)
    await service.reconcileManagedModels()
    expect((await row('session')).model).toBe('zen:B')
    vi.mocked(Date.now).mockReturnValue(301_001)
    const releaseBusy = acquireSessionActivity('session', 'run')
    try {
      await service.reconcileManagedModels()
      expect((await row('session')).model).toBe('zen:B')
    } finally {
      releaseBusy()
    }
    await service.reconcileManagedModels()
    expect(await row('session')).toMatchObject({ model: 'zen:A', plan_model: 'zen:A', small_model: 'zen:A' })
  })
  it('preserves the automatic default intent for a new session created during an outage', async () => {
    mocks.inventory.mockResolvedValue(supply('B'))
    await service.reconcileManagedModels()
    inheritModelPreference('new-session', `agent:${DEFAULT_OPENCODE_AGENT_ID}`, 'zen:B')
    expect(mocks.records['new-session']).toMatchObject({ preferred: 'zen:A', actual: 'zen:B' })
    forgetSessionModelIntent('new-session')
    expect(mocks.records['new-session']).toBeUndefined()
  })
  it('inherits the main and auxiliary preferences through actual session creation', async () => {
    await client.execute("UPDATE agents SET plan_model='zen:A',small_model='zen:A'")
    mocks.inventory.mockResolvedValue(supply('B'))
    await service.reconcileManagedModels()
    vi.spyOn(service as any, 'repairAgentAccessiblePaths').mockImplementation(async (_db, agent) => agent)
    vi.spyOn(service, 'getSession').mockImplementation(async (_agentId, id) => ({ id, ...(await row(id)) }) as any)
    const session = await service.createSession(DEFAULT_OPENCODE_AGENT_ID)
    expect(session).toMatchObject({ model: 'zen:B', plan_model: 'zen:B', small_model: 'zen:B' })
    for (const suffix of ['', ':plan_model', ':small_model']) {
      expect(mocks.records[`${session!.id}${suffix}`]).toMatchObject({ preferred: 'zen:A', actual: 'zen:B' })
    }
  })
  it('applies a new admin default using the original preference, not the temporary fallback', async () => {
    mocks.inventory.mockResolvedValue(supply('B'))
    await service.reconcileManagedModels()
    mocks.snapshot.version = 2
    mocks.snapshot.policy.version = 2
    mocks.snapshot.policy.defaults.assistantNewSession = 'C'
    mocks.inventory.mockResolvedValue(supply('B', 'C'))
    await service.reconcileManagedModels()
    const agent = (await client.execute('SELECT model FROM agents')).rows[0]
    expect(agent.model).toBe('zen:C')
    // Existing conversations retain their own original A, not the new default.
    expect((await row('session')).model).toBe('zen:B')
    expect(mocks.records.session).toMatchObject({ preferred: 'zen:A', actual: 'zen:B' })
  })
  it('coalesces overlapping refreshes and honors a user change made while discovery is pending', async () => {
    let finish!: (value: ReturnType<typeof supply>) => void
    mocks.inventory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const one = service.reconcileManagedModels()
    const two = service.reconcileManagedModels()
    await Promise.resolve()
    await Promise.resolve()
    await client.execute("UPDATE sessions SET model='zen:D' WHERE id='session'")
    finish(supply('B', 'D'))
    await Promise.all([one, two])
    expect(mocks.inventory).toHaveBeenCalledTimes(1)
    expect((await row('session')).model).toBe('zen:D')
  })
})
