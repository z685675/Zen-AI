import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ read: vi.fn(), stat: vi.fn(), list: vi.fn(), process: vi.fn() }))
vi.mock('node:fs/promises', () => ({ default: { readdir: async () => [], readFile: mocks.read, stat: mocks.stat } }))
vi.mock('@main/utils', () => ({
  getDataPath: () => '/global-skills',
  getResourcePath: () => '/bundled-resources',
  toAsarUnpackedPath: (value: string) => value
}))
vi.mock('@main/apiServer/config', () => ({
  config: { get: async () => ({ host: '127.0.0.1', port: 1, apiKey: 'placeholder' }) }
}))
vi.mock('@main/apiServer/utils', () => ({
  validateModelId: async () => ({
    modelId: 'chat',
    provider: { models: [], apiHost: 'http://localhost', type: 'openai', apiKey: 'local' }
  })
}))
vi.mock('../../../skills/SkillRepository', () => ({ SkillRepository: { getInstance: () => ({ list: mocks.list }) } }))
vi.mock('../process', () => ({ getOpenCodeProcess: mocks.process }))

import { applyAutomationProfile } from '../../automation/profile'
import { prepareOpenCodeRuntime } from '../prepare'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.list.mockResolvedValue([
    { folderName: 'custom', isEnabled: true },
    { folderName: 'disabled', isEnabled: false }
  ])
  mocks.read.mockResolvedValue(JSON.stringify({ skills: ['xlsx', 'pptx', '../outside'] }))
  mocks.stat.mockResolvedValue({ isFile: () => true })
})
describe('continuation workspace skills', () => {
  it('does not scan global or user workspace skills for trusted lightweight entries', async () => {
    const session = applyAutomationProfile(
      { id: 'wechat', model: 'p:chat', accessible_paths: ['/wechat-work'], configuration: {} } as any,
      { kind: 'wechat', workspace: '/wechat-work' }
    )
    await prepareOpenCodeRuntime(session, new AbortController().signal)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.process.mock.calls[0][3]).toEqual(['/wechat-work'])
  })
  it('forwards the operation ID before starting the native process', async () => {
    const signal = new AbortController().signal
    const onStarting = vi.fn()
    await prepareOpenCodeRuntime(
      { id: 'new', model: 'p:chat', accessible_paths: ['/user-work'], configuration: {} } as any,
      signal,
      { diagnosticId: 'startup-turn', onStarting }
    )
    expect(mocks.process.mock.calls[0].slice(4)).toEqual([signal, onStarting, 'startup-turn'])
  })
  it('adds builtin packaged skills without provisioning or expanding to the old agent workspace', async () => {
    await prepareOpenCodeRuntime(
      {
        id: 'copy',
        model: 'p:chat',
        accessible_paths: ['/user-work'],
        configuration: { legacy_continuation: { state: 'ready' } }
      } as any,
      new AbortController().signal
    )
    const allowed = mocks.process.mock.calls[0][3]
    expect(allowed).toContain('/user-work')
    expect(allowed).toContain(path.join('/bundled-resources', 'skills', 'xlsx'))
    expect(allowed).toContain(path.join('/bundled-resources', 'skills', 'pptx'))
    expect(allowed).toContain(path.join('/global-skills', 'custom'))
    expect(allowed.some((entry: string) => entry.includes('outside') || entry.includes('disabled'))).toBe(false)
  })
  it('does not change normal new-session skill discovery', async () => {
    await prepareOpenCodeRuntime(
      { id: 'new', model: 'p:chat', accessible_paths: ['/user-work'], configuration: {} } as any,
      new AbortController().signal
    )
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('fails visibly when packaged skill files are missing instead of claiming they loaded', async () => {
    mocks.stat.mockResolvedValue(undefined)
    await expect(
      prepareOpenCodeRuntime(
        {
          id: 'copy',
          model: 'p:chat',
          accessible_paths: ['/user-work'],
          configuration: { legacy_continuation: {} }
        } as any,
        new AbortController().signal
      )
    ).rejects.toThrow('Bundled assistant skill')
    expect(mocks.process).not.toHaveBeenCalled()
  })
})
