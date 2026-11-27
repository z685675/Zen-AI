import { DSH_PREVIEW_IPC } from '@shared/dshPreview'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  prepare: vi.fn(),
  stop: vi.fn(),
  ensure: vi.fn(),
  send: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler) }
}))
vi.mock('./runtime', () => ({
  prepareDshPreviewRuntime: mocks.prepare,
  stopAllDshRuntimes: mocks.stop,
  getDshPreviewRuntimeStatus: () => ({ version: 'test', state: 'ready' })
}))
vi.mock('./builtin', () => ({ ensureDshPreviewAgent: mocks.ensure }))

import { isDshPreviewUnlocked, lockDshPreview } from './access'
import { registerDshPreviewIpc } from './ipc'

const frame = {}
const webContents = { mainFrame: frame, send: mocks.send }
const owner = { sender: webContents, senderFrame: frame }
let currentContents = webContents
const invoke = (channel: keyof typeof DSH_PREVIEW_IPC, event = owner, ...args: unknown[]) =>
  mocks.handlers.get(DSH_PREVIEW_IPC[channel])!(event, ...args)

beforeEach(() => {
  vi.clearAllMocks()
  lockDshPreview()
  mocks.prepare.mockResolvedValue(undefined)
  mocks.stop.mockResolvedValue(undefined)
  currentContents = webContents
  registerDshPreviewIpc(() => ({ webContents: currentContents }) as any)
})

describe('DSH preview main process boundary', () => {
  it('cannot prepare or expose installed runtime details before verification', async () => {
    expect(invoke('status')).toMatchObject({ unlocked: false, state: 'not-installed' })
    await expect(invoke('prepare')).rejects.toThrow('Internal testing is locked')
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.ensure).not.toHaveBeenCalled()
  })

  it('rejects another window and a subframe even with the correct password', () => {
    for (const event of [
      { sender: {} as any, senderFrame: frame },
      { sender: webContents, senderFrame: {} }
    ]) {
      expect(() => invoke('unlock', event, '\u4e16\u754c\u548c\u5e73')).toThrow('Invalid internal testing sender')
    }
    expect(isDshPreviewUnlocked()).toBe(false)
  })

  it('accepts the replacement main window without registering IPC again', () => {
    currentContents = { mainFrame: {}, send: vi.fn() }
    expect(() => invoke('status', owner)).toThrow('Invalid internal testing sender')
    const replacement = { sender: currentContents, senderFrame: currentContents.mainFrame }
    expect(invoke('status', replacement)).toMatchObject({ unlocked: false })
  })

  it('revokes access immediately and prevents an in-flight preparation from opening the assistant', async () => {
    invoke('unlock', owner, '\u4e16\u754c\u548c\u5e73')
    let finish!: () => void
    mocks.prepare.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const preparing = invoke('prepare')
    const closing = invoke('lock')
    expect(isDshPreviewUnlocked()).toBe(false)
    finish()
    await expect(preparing).rejects.toThrow('Internal testing is locked')
    await closing
    expect(mocks.stop).toHaveBeenCalledOnce()
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(invoke('status')).toMatchObject({ unlocked: false })
  })
})
