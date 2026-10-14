import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:os')

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), request: vi.fn(), release: vi.fn() }))
vi.mock('../prepare', () => ({ prepareOpenCodeRuntime: mocks.prepare }))

import {
  buildContinuationContext,
  cloneContinuationHistory,
  continuationArchiveText,
  continuationRecords,
  copyContinuationAttachments,
  readContinuationHistory,
  seedContinuationMemory
} from '../continuation'
import { planNativeHistory } from '../history'

const fixture = () =>
  [
    {
      message: {
        id: 'u',
        topicId: 'agent-session:old',
        role: 'user',
        createdAt: '2026-10-11T01:00:00Z',
        status: 'success',
        blocks: ['b']
      },
      blocks: [
        { id: 'b', messageId: 'u', type: 'main_text', status: 'success', content: 'Create a file: historical request' }
      ]
    },
    {
      message: {
        id: 'a',
        topicId: 'agent-session:old',
        role: 'assistant',
        askId: 'u',
        createdAt: '2026-10-11T01:01:00Z',
        status: 'processing',
        blocks: ['t', 'thinking'],
        agentSessionId: 'sdk-old',
        providerMetadata: { agentSessionSync: { target: 'wechat' } }
      },
      blocks: [
        { id: 't', messageId: 'a', type: 'tool', status: 'processing', toolName: 'write', content: 'old result' },
        { id: 'thinking', messageId: 'a', type: 'thinking', content: 'private reasoning' }
      ]
    }
  ] as any
const directories: string[] = []
afterEach(async () => {
  for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('legacy continuation safety', () => {
  it('makes long text archives readable by line-oriented native tools', () => {
    const items = fixture()
    items[0].blocks[0].content = 'a'.repeat(2500)
    const archive = continuationArchiveText(items)
    expect(archive).toContain('HISTORICAL DATA ONLY')
    expect(archive.split('\n').every((line) => [...line].length <= 1200)).toBe(true)
    expect(archive).not.toContain('private reasoning')
  })
  it('remaps all identifiers and pauses unfinished tools without changing originals', () => {
    const old = fixture(),
      before = structuredClone(old)
    const items = cloneContinuationHistory(old, 'new', 'old')
    expect(old).toEqual(before)
    expect(items[1].message.askId).toBe(items[0].message.id)
    expect(items[1].message.agentSessionId).toBeUndefined()
    expect(items[1].message.providerMetadata?.agentSessionSync).toBeUndefined()
    expect(items[1].message.status).toBe('paused')
    expect(items[1].blocks[0].status).toBe('paused')
    for (const item of items) {
      expect(item.message.topicId).toBe('agent-session:new')
      expect(item.blocks.map((block) => block.id)).toEqual(item.message.blocks)
      expect(item.blocks.every((block) => block.messageId === item.message.id)).toBe(true)
      expect(item.message.providerMetadata?.legacyContinuation?.source_session_id).toBe('old')
    }
  })
  it('validates histories and refuses malformed, empty and excessive data', () => {
    expect(readContinuationHistory(fixture().map((item) => ({ content: JSON.stringify(item) })))).toHaveLength(2)
    for (const rows of [
      [],
      [{ content: '{}' }],
      [{ content: '{' }],
      fixture().map((item) => ({ content: JSON.stringify({ ...item, blocks: [] }) }))
    ])
      expect(() => readContinuationHistory(rows)).toThrow(/continuation_/)
    expect(() => readContinuationHistory(Array.from({ length: 20001 }, () => ({ content: '{}' })))).toThrow('too_large')
  })
  it.each([0, 128, 512, 1024, 24000])('strictly bounds background to %i characters', (limit) => {
    const items = fixture()
    items[0].blocks[0].content = 'x'.repeat(80000)
    expect(buildContinuationContext(items, '/archive/history.json', limit).length).toBeLessThanOrEqual(limit)
  })
  it('archives tools as inert data and excludes reasoning', () => {
    const archive = JSON.stringify(continuationRecords(fixture()))
    expect(archive).toContain('historical_tool')
    expect(archive).not.toContain('private reasoning')
    const context = buildContinuationContext(fixture(), '/archive/history.json')
    expect(context).toContain('Do NOT replay tools')
    expect(context).toContain('/archive/history.json')
  })
  it('copies only uploads within allowed roots; missing files do not block the transfer', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-continuation-'))
    directories.push(root)
    const storage = path.join(root, 'files'),
      target = path.join(root, 'copy'),
      denied = path.join(root, 'secret.txt')
    await fs.mkdir(storage)
    await fs.mkdir(target)
    await fs.writeFile(path.join(storage, 'upload.xlsx'), 'sheet')
    await fs.writeFile(denied, 'secret')
    const items = fixture().slice(0, 1)
    items[0].blocks = ['upload', 'missing', 'denied'].map((id) => ({
      id,
      messageId: 'u',
      type: 'file',
      file: { id, name: id === 'upload' ? 'upload.xlsx' : `${id}.txt`, ext: '.txt', origin_name: id, path: denied }
    }))
    const warnings = await copyContinuationAttachments(items, target, [], storage)
    expect(warnings).toEqual(['missing', 'denied'])
    const copied = items[0].blocks[0]
    expect(copied.metadata.legacyContinuation.copied_attachment).toBe(true)
    await fs.rm(storage, { recursive: true })
    expect(await fs.readFile(copied.file.path, 'utf8')).toBe('sheet')
    expect(await fs.readFile(denied, 'utf8')).toBe('secret')
  })
  it('uses noReply synthetic text and verifies persistence, always releasing runtime', async () => {
    mocks.prepare.mockResolvedValue({
      session: async () => 'native',
      client: { request: mocks.request },
      release: mocks.release
    })
    mocks.request.mockImplementation(async (_route, method) =>
      method === 'POST'
        ? undefined
        : [{ info: { id: mocks.request.mock.calls[0][2].messageID }, parts: [{ type: 'text', text: 'history' }] }]
    )
    await expect(
      seedContinuationMemory({ model: 'p:gpt-6' } as any, 'history', new AbortController().signal)
    ).resolves.toBe('native')
    expect(mocks.request.mock.calls[0][2]).toMatchObject({
      noReply: true,
      parts: [{ type: 'text', text: 'history', synthetic: true }]
    })
    expect(mocks.release).toHaveBeenCalledTimes(1)
    mocks.request.mockResolvedValue([])
    await expect(
      seedContinuationMemory({ model: 'p:gpt-6' } as any, 'history', new AbortController().signal)
    ).rejects.toThrow('memory_failed')
    expect(mocks.release).toHaveBeenCalledTimes(2)
  })
  it('rejects old actions but keeps background for retries of newly sent messages', () => {
    const imported = cloneContinuationHistory(fixture(), 'new', 'old')
    const fresh = {
      message: {
        id: 'fresh-u',
        role: 'user',
        blocks: [],
        providerMetadata: { opencode: { user_message_id: 'native-u' } }
      },
      blocks: []
    }
    const answer = { message: { id: 'fresh-a', role: 'assistant', askId: 'fresh-u', blocks: [] }, blocks: [] }
    const native = [
      { info: { id: 'background', role: 'user' }, parts: [{ type: 'text', synthetic: true }] },
      { info: { id: 'native-u', role: 'user' }, parts: [{ type: 'text' }] },
      { info: { id: 'native-a', role: 'assistant' }, parts: [{ type: 'text' }] }
    ]
    const display = [...imported, fresh, answer] as any
    expect(() => planNativeHistory(native, display, imported[0].message.id, 'retry')).toThrow('read-only')
    expect(planNativeHistory(native, display, 'fresh-a', 'retry').cutoff).toBe(1)
    expect(planNativeHistory(native, display, 'fresh-a', 'delete').remove).toEqual(['native-a'])
    expect(planNativeHistory(native, display, 'fresh-a', 'fork').keepDisplay).toHaveLength(4)
  })
})
