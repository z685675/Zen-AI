import { EventEmitter } from 'node:events'

import { IpcChannel } from '@shared/IpcChannel'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fromId: vi.fn(),
  fromWebContents: vi.fn(),
  handlers: new Map<string, (...args: any[]) => any>()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents, fromId: mocks.fromId },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => mocks.handlers.set(channel, handler) }
}))

import storeSyncService from '../StoreSyncService'

function createWindow(id: number) {
  const webContents = Object.assign(new EventEmitter(), { mainFrame: {}, send: vi.fn() })
  const window = Object.assign(new EventEmitter(), { id, webContents, isDestroyed: () => false })
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  return { window, event }
}

describe('StoreSyncService persistence owner delivery', () => {
  it('replays secondary updates in order to the restored main window and forwards live updates', () => {
    const secondary = createWindow(1)
    const initial = createWindow(2)
    const replacement = createWindow(3)
    const fixtures = [secondary, initial, replacement]
    mocks.fromWebContents.mockImplementation(
      (contents) => fixtures.find(({ window }) => window.webContents === contents)?.window
    )
    mocks.fromId.mockImplementation((id) => fixtures.find(({ window }) => window.id === id)?.window)
    storeSyncService.registerIpcHandler()
    const subscribe = mocks.handlers.get(IpcChannel.StoreSync_Subscribe)!
    const update = mocks.handlers.get(IpcChannel.StoreSync_OnUpdate)!
    const action = (value: string) => ({ type: 'mcp/update', payload: value })

    storeSyncService.bindMainWindow(initial.window as unknown as Electron.BrowserWindow)
    subscribe(initial.event)
    subscribe(secondary.event)
    initial.window.emit('closed')
    update(secondary.event, action('while closed'))
    storeSyncService.bindMainWindow(replacement.window as unknown as Electron.BrowserWindow)
    update(secondary.event, action('while loading'))

    expect(replacement.window.webContents.send).not.toHaveBeenCalled()
    expect(subscribe(secondary.event)).toEqual([])
    expect(subscribe(replacement.event)).toMatchObject([action('while closed'), action('while loading')])
    expect(subscribe(replacement.event)).toEqual([])
    update(secondary.event, action('ready'))
    expect(replacement.window.webContents.send).toHaveBeenCalledExactlyOnceWith(
      IpcChannel.StoreSync_BroadcastSync,
      expect.objectContaining(action('ready'))
    )
  })
})
