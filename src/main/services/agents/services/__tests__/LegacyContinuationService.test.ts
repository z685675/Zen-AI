import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:os')
const mocks = vi.hoisted(() => ({
  database: null as any,
  source: null as any,
  candidates: [] as any[],
  create: vi.fn(),
  remove: vi.fn(),
  seed: vi.fn(),
  models: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  ensure: vi.fn(),
  validate: vi.fn()
}))
vi.mock('../../BaseService', () => ({
  BaseService: class {
    getDatabase() {
      return Promise.resolve(mocks.database)
    }
    deserializeJsonFields(row: any) {
      const result = { ...row }
      for (const key of ['configuration', 'accessible_paths'])
        if (typeof result[key] === 'string') result[key] = JSON.parse(result[key])
      return result
    }
  }
}))
vi.mock('../SessionService', () => ({ sessionService: { createSession: mocks.create, deleteSession: mocks.remove } }))
vi.mock('../opencode/builtin', () => ({ ensureOpenCodeAgent: mocks.ensure }))
vi.mock('../opencode/continuation', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  seedContinuationMemory: mocks.seed
}))
vi.mock('@main/apiServer/services/models', () => ({ modelsService: { getModels: mocks.models } }))
vi.mock('@main/apiServer/utils', () => ({ validateModelId: mocks.validate }))
vi.mock('@main/services/ConfigManager', () => ({ configManager: { getEnableDeveloperMode: () => true } }))
vi.mock('@main/services/RemoteModelPolicyService', () => ({
  remoteModelPolicyService: { getSnapshot: () => ({ policy: undefined }) }
}))
vi.mock('@main/utils', () => ({ getDataPath: () => path.join(mocks.source?.directory ?? '', 'missing-storage') }))
vi.mock('../opencode/prepare', () => ({ prepareOpenCodeRuntime: vi.fn() }))

import { sessionMessagesTable } from '../../database/schema'
import { LegacyContinuationService } from '../LegacyContinuationService'
import { acquireSessionActivity } from '../sessionActivity'

let root: string
const history = () => [
  {
    message: { id: 'u', role: 'user', createdAt: '2026-10-11T01:00:00Z', status: 'success', blocks: ['b'] },
    blocks: [{ id: 'b', messageId: 'u', type: 'main_text', content: 'Remember purple', status: 'success' }]
  }
]
const rows = () => history().map((item) => ({ content: JSON.stringify(item) }))
beforeEach(async () => {
  vi.clearAllMocks()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-transition-service-'))
  mocks.source = {
    id: 'old',
    agent_id: 'legacy',
    agent_type: 'claude-code',
    name: 'Old conversation',
    model: 'p:gpt-6',
    directory: root,
    accessible_paths: JSON.stringify([root]),
    configuration: JSON.stringify({
      permission_mode: 'bypassPermissions',
      scheduler_enabled: true,
      env_vars: { SECRET: 'never inherit' }
    })
  }
  mocks.candidates = []
  const select = () => ({
    from: (table: unknown) => ({
      where: () =>
        table === sessionMessagesTable
          ? { orderBy: async () => rows(), limit: async () => [{ id: 1 }] }
          : {
              limit: async () => (mocks.source ? [mocks.source] : []),
              then: (resolve: (value: any) => any) => Promise.resolve(resolve(mocks.candidates))
            }
    })
  })
  mocks.database = {
    select,
    transaction: async (callback: any) =>
      callback({
        select,
        insert: () => ({ values: mocks.insert }),
        update: () => ({
          set: (data: any) => {
            mocks.update(data)
            return { where: async () => undefined }
          }
        })
      })
  }
  mocks.ensure.mockResolvedValue(true)
  mocks.models.mockResolvedValue({ data: [{ id: 'p:gpt-6', name: 'gpt-6', provider: 'p' }] })
  mocks.validate.mockResolvedValue({
    modelId: 'gpt-6',
    provider: { models: [{ id: 'gpt-6', contextWindowTokens: 100000 }] }
  })
  mocks.create.mockImplementation(async (_agent: string, req: any) => ({
    ...req,
    id: 'target',
    agent_id: DEFAULT_OPENCODE_AGENT_ID,
    agent_type: 'claude-code',
    is_archived: true
  }))
  mocks.seed.mockResolvedValue('native')
  mocks.remove.mockResolvedValue(true)
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})
const run = () => new LegacyContinuationService().continueSession('legacy', 'old', new AbortController().signal)

describe('legacy-to-new snapshot transaction', () => {
  it('preserves the original, resets approvals/bindings, seeds before publishing and saves the complete archive', async () => {
    const before = structuredClone(mocks.source)
    const result = await run()
    expect(mocks.source).toEqual(before)
    expect(result.session.is_archived).toBe(false)
    expect(mocks.create.mock.calls[0][2]).toEqual({ archived: true })
    expect(result.session.configuration).toMatchObject({
      permission_mode: 'default',
      env_vars: {},
      scheduler_enabled: false,
      heartbeat_enabled: false,
      legacy_continuation: { state: 'ready', target_session_id: 'target', message_count: 1 }
    })
    expect(result.session.instructions).toBe('')
    expect(result.session.mcps).toEqual([])
    expect(mocks.insert).toHaveBeenCalledTimes(1)
    const copied = JSON.parse(mocks.insert.mock.calls[0][0].content)
    expect(copied.message.id).not.toBe('u')
    const archive = result.session.configuration!.legacy_continuation as any
    expect(JSON.parse(await fs.readFile(archive.structured_archive_path, 'utf8')).messages[0].content).toEqual([
      'Remember purple'
    ])
    expect(await fs.readFile(archive.archive_path, 'utf8')).toContain('Remember purple')
    expect(mocks.seed.mock.invocationCallOrder[0]).toBeLessThan(mocks.insert.mock.invocationCallOrder[0])
  })
  it('reuses a ready canonical copy after a lost response but never selects a branch as the canonical target', async () => {
    const first = await run()
    mocks.candidates = [{ ...first.session, id: 'branch' }, first.session]
    const second = await run()
    expect(second.reused).toBe(true)
    expect(second.session.id).toBe('target')
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.seed).toHaveBeenCalledTimes(1)
  })
  it('removes only the hidden target if seed persistence fails', async () => {
    mocks.seed.mockRejectedValue(new Error('runtime unavailable'))
    await expect(run()).rejects.toThrow('runtime unavailable')
    expect(mocks.remove).toHaveBeenCalledWith(DEFAULT_OPENCODE_AGENT_ID, 'target')
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.source.id).toBe('old')
  })
  it('detects source changes before committing the copy', async () => {
    mocks.seed.mockImplementation(async () => {
      mocks.source.name = 'Changed'
      return 'native'
    })
    await expect(run()).rejects.toThrow('source_changed')
    expect(mocks.insert).not.toHaveBeenCalled()
    expect(mocks.remove).toHaveBeenCalledWith(DEFAULT_OPENCODE_AGENT_ID, 'target')
  })
  it('blocks duplicate copying and migration during an active task', async () => {
    const release = acquireSessionActivity('old', 'run')
    try {
      await expect(run()).rejects.toThrow('Stop')
      expect(mocks.create).not.toHaveBeenCalled()
    } finally {
      release()
    }
  })
  it('cleans up interrupted hidden preparation before trying again', async () => {
    const first = await run()
    mocks.candidates = [
      {
        ...first.session,
        id: 'crashed',
        configuration: {
          legacy_continuation: { ...(first.session.configuration!.legacy_continuation as any), state: 'preparing' }
        }
      }
    ]
    // A new target uses a new directory in the actual service.
    mocks.create.mockImplementation(async (_agent: string, req: any) => ({
      ...req,
      id: 'replacement',
      agent_id: DEFAULT_OPENCODE_AGENT_ID
    }))
    const result = await run()
    expect(result.session.id).toBe('replacement')
    expect(mocks.remove).toHaveBeenCalledWith(DEFAULT_OPENCODE_AGENT_ID, 'crashed')
  })
  it('fails safely when no model exists, the source is missing, or the request was cancelled', async () => {
    mocks.models.mockResolvedValue({ data: [] })
    await expect(run()).rejects.toThrow('no_model')
    expect(mocks.create).not.toHaveBeenCalled()
    mocks.source = null
    await expect(run()).rejects.toThrow('source_missing')
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})
