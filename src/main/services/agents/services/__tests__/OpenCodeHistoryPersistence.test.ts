import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  transaction: vi.fn(),
  edit: vi.fn(),
  copy: vi.fn(),
  remove: vi.fn(),
  insert: vi.fn(),
  update: vi.fn()
}))
vi.mock('../../BaseService', () => ({
  BaseService: class {
    getDatabase() {
      return Promise.resolve({ select: mocks.select, transaction: mocks.transaction })
    }
  }
}))
vi.mock('../opencode/history', () => ({ editNativeHistory: mocks.edit }))
vi.mock('../opencode/process', () => ({ copyOpenCodeHistory: mocks.copy }))
vi.mock('../claudecode/commands', () => ({ builtinSlashCommands: [] }))
import { SessionService } from '../SessionService'

const session = {
  id: 'source',
  agent_id: DEFAULT_OPENCODE_AGENT_ID,
  accessible_paths: ['/original-workspace'],
  model: 'provider:model',
  configuration: { agent_runtime: 'opencode' },
  name: 'test'
} as any
const history = () => [
  {
    message: {
      id: 'user',
      topicId: 'agent-session:source',
      role: 'user',
      blocks: ['input'],
      createdAt: '2026-10-11T01:00:00Z'
    },
    blocks: [{ id: 'input', messageId: 'user', type: 'main_text', content: 'hello' }]
  },
  {
    message: {
      id: 'reply',
      topicId: 'agent-session:source',
      role: 'assistant',
      askId: 'user',
      blocks: ['output'],
      createdAt: '2026-10-11T01:00:01Z'
    },
    blocks: [{ id: 'output', messageId: 'reply', type: 'main_text', content: 'reply' }]
  }
]
beforeEach(() => {
  vi.clearAllMocks()
  mocks.select.mockReturnValue({
    from: () => ({
      where: () => ({ orderBy: async () => history().map((item, i) => ({ id: i, content: JSON.stringify(item) })) })
    })
  })
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      delete: () => ({ where: mocks.remove }),
      insert: () => ({ values: mocks.insert }),
      update: () => ({ set: () => ({ where: mocks.update }) })
    })
  )
  mocks.edit.mockImplementation(async (_session, display, _message, _action, commit) => commit(display, 'native-copy'))
  mocks.copy.mockResolvedValue(undefined)
})
describe('new assistant persisted history operations', () => {
  it('creates a real independent session and remaps message, block and ask IDs together', async () => {
    const service = new SessionService()
    vi.spyOn(service, 'getSession').mockImplementation(async (_agent, id) => ({ ...session, id }))
    const create = vi.spyOn(service, 'createSession').mockResolvedValue({ ...session, id: 'branch' })
    const result = await service.changeOpenCodeHistory(DEFAULT_OPENCODE_AGENT_ID, 'source', 'reply', 'fork')
    expect(result.id).toBe('branch')
    expect(create.mock.calls[0][1]?.accessible_paths).toEqual(['/original-workspace'])
    expect(mocks.copy).toHaveBeenCalledWith('source', 'branch')
    const inserted = mocks.insert.mock.calls.map(([row]) => ({ row, item: JSON.parse(row.content) }))
    expect(inserted.map(({ row }) => row.session_id)).toEqual(['branch', 'branch'])
    const user = inserted[0].item,
      reply = inserted[1].item
    expect(user.message.id).not.toBe('user')
    expect(reply.message.id).not.toBe('reply')
    expect(reply.message.askId).toBe(user.message.id)
    for (const { item } of inserted) {
      expect(item.message.topicId).toBe('agent-session:branch')
      expect(item.message.blocks).toEqual(item.blocks.map((block: any) => block.id))
      expect(item.blocks.every((block: any) => block.messageId === item.message.id)).toBe(true)
    }
  })
  it('only rewrites display history after native history has been changed successfully', async () => {
    const service = new SessionService()
    vi.spyOn(service, 'getSession').mockResolvedValue(session)
    mocks.edit.mockRejectedValue(new Error('active task'))
    await expect(service.changeOpenCodeHistory(DEFAULT_OPENCODE_AGENT_ID, 'source', 'reply', 'delete')).rejects.toThrow(
      'active task'
    )
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.insert).not.toHaveBeenCalled()
  })
  it('removes only the newly created branch when copying fails', async () => {
    const service = new SessionService()
    vi.spyOn(service, 'getSession').mockResolvedValue(session)
    vi.spyOn(service, 'createSession').mockResolvedValue({ ...session, id: 'branch' })
    const remove = vi.spyOn(service, 'deleteSession').mockResolvedValue(true)
    mocks.copy.mockRejectedValue(new Error('disk full'))
    await expect(service.changeOpenCodeHistory(DEFAULT_OPENCODE_AGENT_ID, 'source', 'reply', 'fork')).rejects.toThrow(
      'disk full'
    )
    expect(remove).toHaveBeenCalledWith(DEFAULT_OPENCODE_AGENT_ID, 'branch')
    expect(mocks.edit).not.toHaveBeenCalled()
  })
  it('rejects old-assistant and unknown messages without changing history', async () => {
    const service = new SessionService()
    vi.spyOn(service, 'getSession').mockResolvedValue(session)
    await expect(service.changeOpenCodeHistory('legacy', 'source', 'reply', 'delete')).rejects.toThrow('Not a new')
    await expect(
      service.changeOpenCodeHistory(DEFAULT_OPENCODE_AGENT_ID, 'source', 'missing', 'delete')
    ).rejects.toThrow('Message not found')
    expect(mocks.edit).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
