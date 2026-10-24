import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  views: [] as Array<{
    preferences: Record<string, unknown>
    contents: { loadURL: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  }>
}))
vi.mock('electron', () => ({
  net: { fetch: mocks.fetch },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      removeAllListeners: vi.fn(),
      on: vi.fn()
    })
  },
  WebContentsView: class {
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      loadURL: vi.fn().mockResolvedValue(undefined),
      close: vi.fn()
    }
    setBounds = vi.fn()
    setVisible = vi.fn()
    constructor(options: { webPreferences: Record<string, unknown> }) {
      mocks.views.push({ preferences: options.webPreferences, contents: this.webContents })
    }
  }
}))

import { ImageStudioService } from '../ImageStudioService'

const input = {
  apiHost: 'https://gateway.example/v1',
  apiKey: 'private-key',
  bounds: { x: 10, y: 20, width: 600, height: 400 }
}
const handoff = () => new Response(JSON.stringify({ success: true, data: { code: 'a'.repeat(64) } }))
function host() {
  return {
    once: vi.fn(),
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { getZoomFactor: () => 1, on: vi.fn() }
  }
}

describe('isolated image workspace view', () => {
  beforeEach(() => {
    mocks.fetch.mockReset()
    mocks.views.length = 0
  })

  it('keeps credentials out of URLs and never gives the remote page the desktop preload', async () => {
    mocks.fetch.mockResolvedValue(handoff())
    const window = host()
    const service = new ImageStudioService(window as unknown as BrowserWindow)
    expect(await service.open(input)).toEqual({ ok: true })
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://gateway.example/api/image-studio/handoff')
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer private-key')
    const view = mocks.views[0]
    expect(view.preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    })
    expect(view.preferences.preload).toBeUndefined()
    expect(view.contents.loadURL.mock.calls[0][0]).not.toContain(input.apiKey)
    service.close()
    expect(view.contents.close).toHaveBeenCalledOnce()
  })

  it('does not attach a late response after leaving the image page', async () => {
    let resolve!: (response: Response) => void
    mocks.fetch.mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done
      })
    )
    const window = host()
    const service = new ImageStudioService(window as unknown as BrowserWindow)
    const opening = service.open(input)
    service.close()
    resolve(handoff())
    expect(await opening).toEqual({ ok: false })
    expect(window.contentView.addChildView).not.toHaveBeenCalled()
    expect(mocks.views).toHaveLength(0)
  })
})
