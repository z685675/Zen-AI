import { EventEmitter } from 'node:events'

import { IpcChannel } from '@shared/IpcChannel'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  handlers: new Map<string, (event: unknown) => void>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel, handler) => mocks.handlers.set(channel, handler))
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ error: vi.fn() })
  }
}))

vi.mock('../CacheService', () => ({
  CacheService: { remove: mocks.remove }
}))

import { invalidateApiServerProvidersCacheForAction, reduxService } from '../ReduxService'

const createContents = () =>
  Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    executeJavaScript: vi.fn().mockResolvedValue(undefined)
  })
const signalReady = (sender: ReturnType<typeof createContents>, senderFrame = sender.mainFrame) =>
  mocks.handlers.get(IpcChannel.ReduxStoreReady)!({ sender, senderFrame })

describe('ReduxService', () => {
  let contents: ReturnType<typeof createContents>

  beforeEach(() => {
    vi.clearAllMocks()
    contents = createContents()
    reduxService.bindWindow({ webContents: contents } as unknown as Electron.BrowserWindow)
  })

  it('clears the API server provider cache for provider mutations dispatched by the main process', async () => {
    signalReady(contents)
    await reduxService.dispatch({ type: 'llm/updateProvider', payload: { id: 'openai', apiKey: 'new-key' } })
    expect(contents.executeJavaScript).toHaveBeenCalled()
    expect(mocks.remove).toHaveBeenCalledWith('api-server:providers')
  })

  it('leaves the provider cache intact for unrelated actions', () => {
    invalidateApiServerProvidersCacheForAction('llm/setDefaultModel')
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('waits for rehydration in the current main frame', async () => {
    const ready = vi.fn()
    const startup = reduxService.waitUntilReady().then(ready)
    signalReady(createContents())
    signalReady(contents, {})
    await Promise.resolve()
    expect(ready).not.toHaveBeenCalled()
    signalReady(contents)
    await startup
    expect(ready).toHaveBeenCalledOnce()
  })

  it('waits again after a reload or window replacement', async () => {
    signalReady(contents)
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    await expect(reduxService.waitUntilReady()).resolves.toBeUndefined()
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    const ready = vi.fn()
    const reinstated = reduxService.waitUntilReady().then(ready)

    const replacement = createContents()
    reduxService.bindWindow({ webContents: replacement } as unknown as Electron.BrowserWindow)
    signalReady(contents)
    await Promise.resolve()
    expect(ready).not.toHaveBeenCalled()
    signalReady(replacement)
    await reinstated
    await reduxService.getState()
    expect(ready).toHaveBeenCalledOnce()
    expect(contents.executeJavaScript).not.toHaveBeenCalled()
    expect(replacement.executeJavaScript).toHaveBeenCalledOnce()
  })
})
