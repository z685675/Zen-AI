import { pathToFileURL } from 'node:url'

import { imageCanvasChannels as channels } from '@shared/config/imageCanvas'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: any, input?: any) => any>(),
  listeners: new Map<string, (event: any) => void>(),
  views: [] as any[],
  beforeRequest: vi.fn(),
  submit: vi.fn()
}))
vi.mock('../imageCanvas/TaskStore', () => ({
  ImageCanvasTaskStore: class {
    submit = mocks.submit
    history = () => []
  }
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/user-data' },
  net: { fetch: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: any) => mocks.handlers.set(channel, handler),
    removeHandler: vi.fn(),
    on: (channel: string, listener: any) => mocks.listeners.set(channel, listener)
  },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      webRequest: { onBeforeRequest: mocks.beforeRequest }
    })
  },
  WebContentsView: class {
    webContents = {
      mainFrame: { url: '' },
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      isDestroyed: () => false,
      loadFile: vi.fn(async (path: string) => {
        this.webContents.mainFrame.url = pathToFileURL(path).href
      }),
      close: vi.fn(),
      send: (channel: string) => {
        if (channel === channels.flush)
          mocks.listeners.get(channels.flushed)?.({ sender: this.webContents, senderFrame: this.webContents.mainFrame })
      }
    }
    setBounds = vi.fn()
    setVisible = vi.fn()
    constructor(public options: unknown) {
      mocks.views.push(this)
    }
  }
}))

import { ImageCanvasService } from '../ImageCanvasService'

describe('bundled canvas isolation', () => {
  it('exposes a secret-free catalog only to the exact local canvas main frame', async () => {
    const host = {
      once: vi.fn(),
      isDestroyed: () => false,
      webContents: { getZoomFactor: () => 1 },
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
    }
    const service = new ImageCanvasService(host as unknown as BrowserWindow)
    const provider = {
      id: 'p',
      name: 'Configured provider',
      apiHost: 'https://secret-host.example',
      apiKey: 'private-key',
      models: [{ id: 'image', name: 'Image', protocol: 'openai' as const }]
    }
    expect(await service.open({ providers: [provider], bounds: { x: 0, y: 0, width: 640, height: 480 } })).toEqual({
      ok: true
    })
    const view = mocks.views.at(-1)
    expect(view.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    })
    expect(view.options.webPreferences.preload).toContain('imageCanvas.js')
    const handler = mocks.handlers.get(channels.catalog)!
    const sender = { sender: view.webContents, senderFrame: view.webContents.mainFrame }
    const catalog = await handler(sender)
    expect(JSON.stringify(catalog)).not.toContain('private-key')
    expect(JSON.stringify(catalog)).not.toContain('secret-host')
    expect(catalog[0].models[0].id).toBe('image')
    expect(() => handler({ ...sender, senderFrame: {} })).toThrow('invalid_canvas_sender')
    expect(() => handler({ ...sender, sender: {} })).toThrow('invalid_canvas_sender')
    const filter = mocks.beforeRequest.mock.calls[0][0]
    const callback = vi.fn()
    filter({ url: 'https://external.example/analytics.js' }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    filter({ url: 'file:///C:/Users/other/private.txt' }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    await service.close()
    expect(() => handler(sender)).toThrow('invalid_canvas_sender')
    expect(view.webContents.close).toHaveBeenCalledOnce()
  })
  it('loads the separate workbench in the same restricted bridge and rejects the legacy frame', async () => {
    const host = {
      once: vi.fn(),
      isDestroyed: () => false,
      webContents: { getZoomFactor: () => 1 },
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
    }
    const service = new ImageCanvasService(host as unknown as BrowserWindow)
    const fontFamily = 'A "Rounded" 字体'
    await service.open({
      providers: [],
      bounds: { x: 0, y: 0, width: 900, height: 700 },
      userFontFamily: fontFamily
    })
    const view = mocks.views.at(-1)
    expect(view.webContents.loadFile.mock.calls[0][0]).toContain('image-workbench')
    const appearance = new URLSearchParams(view.webContents.loadFile.mock.calls[0][1].hash)
    expect(appearance.get('fontFamily')).toBe(fontFamily)
    expect(appearance.get('os')).toBe(
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'
    )
    const handler = mocks.handlers.get(channels.catalog)!
    const frame = view.webContents.mainFrame
    expect(await handler({ sender: view.webContents, senderFrame: frame })).toEqual([])
    frame.url = frame.url.replace('image-workbench', 'image-canvas')
    expect(() => handler({ sender: view.webContents, senderFrame: frame })).toThrow('invalid_canvas_sender')
    frame.url = frame.url.replace('image-canvas', 'image-workbench')
    await service.close()
  })
})
