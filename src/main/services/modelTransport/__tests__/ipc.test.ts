import { MODEL_TRANSPORT_IPC } from '@shared/modelTransport'
import { app, net, session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  fetch: vi.fn(),
  trusted: false
}))
vi.mock('electron', async () => ({
  app: { isPackaged: false, once: vi.fn() },
  ipcMain: { handle: vi.fn((name, handler) => state.handlers.set(name, handler)) },
  net: { fetch: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn().mockResolvedValue('DIRECT') } }
}))
vi.mock('../../hotpatch/security', () => ({ trustedHotpatchFrame: () => state.trusted }))
vi.mock('../../DiagnosticEvidenceService', () => ({ recordMainDiagnostic: vi.fn() }))
vi.mock('../transport', () => ({ modelApiTransport: { fetch: state.fetch, destroy: vi.fn() } }))

import { registerModelTransportIpc } from '../ipc'
import { modelApiTransport } from '../transport'

function event(url = 'http://localhost:5173/') {
  const frame = { url }
  const callbacks = new Map<string, () => void>()
  const sender = {
    id: 7,
    mainFrame: frame,
    session: session.defaultSession,
    isDestroyed: () => false,
    once: vi.fn((name, callback) => callbacks.set(name, callback)),
    on: vi.fn((name, callback) => callbacks.set(name, callback))
  }
  return { sender, senderFrame: frame, callbacks }
}
const request = {
  id: 'turn-1',
  url: 'https://zenai.925636.xyz/v1/chat/completions',
  method: 'POST',
  headers: [['Authorization', 'Bearer TEST_KEY']] as [string, string][],
  body: '{"stream":true}'
}
const start = (...args: any[]) => state.handlers.get(MODEL_TRANSPORT_IPC.start)!(...args)

beforeEach(() => {
  vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
  state.handlers.clear()
  state.trusted = false
  Object.assign(app, { isPackaged: false })
  state.fetch.mockReset().mockResolvedValue(new Response('ok'))
  registerModelTransportIpc()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('model transport IPC trust and lifecycle', () => {
  it.each(['/', '/index.html', '/miniWindow.html', '/selectionAction.html?x=1'])(
    'accepts the app development entry %s',
    async (entry) => {
      const result = await start(event(`http://localhost:5173${entry}`), request)
      expect(result).toMatchObject({ ok: true, status: 200 })
      expect(state.fetch).toHaveBeenCalledOnce()
    }
  )

  it('rejects websites, subframes, browser partitions and destroyed senders before starting a request', () => {
    const external = event('https://example.com')
    const otherDevPage = event('http://localhost:5173/browser.html')
    const subframe = event()
    subframe.senderFrame = { url: subframe.senderFrame.url }
    const browser = event()
    browser.sender.session = {} as typeof session.defaultSession
    const destroyed = event()
    destroyed.sender.isDestroyed = () => true
    for (const candidate of [external, otherDevPage, subframe, browser, destroyed]) {
      expect(() => start(candidate, request)).toThrow('Invalid model transport sender')
    }
    expect(state.fetch).not.toHaveBeenCalled()
  })

  it('requires the trusted packaged entry and preserves the proxy-aware native fallback', async () => {
    Object.assign(app, { isPackaged: true })
    expect(() => start(event(), request)).toThrow('Invalid model transport sender')
    state.trusted = true
    expect(await start(event('file:///app/out/renderer/index.html'), request)).toMatchObject({ ok: true })
    const [, options, , nativeFetch] = state.fetch.mock.calls[0]
    expect(options).toMatchObject({
      body: request.body,
      credentials: 'omit',
      redirect: 'manual',
      signal: expect.any(AbortSignal)
    })
    await nativeFetch('https://zenai.925636.xyz/v1/models', {})
    expect(net.fetch).toHaveBeenCalledWith('https://zenai.925636.xyz/v1/models', {})
    expect(await modelApiTransport.resolveProxy?.(request.url)).toBe('DIRECT')
  })

  it.each([
    ['timeout', 'TimeoutError'],
    [undefined, 'AbortError']
  ])('restores the cancellation category from IPC (%s)', async (reason, name) => {
    const owner = event()
    await start(owner, request)
    const signal = state.fetch.mock.calls[0][1].signal as AbortSignal
    await state.handlers.get(MODEL_TRANSPORT_IPC.cancel)!(owner, request.id, reason)
    expect(signal.reason).toHaveProperty('name', name)
  })

  it.each(['destroyed', 'render-process-gone', 'did-navigate'])(
    'cancels active streams when the owner emits %s',
    async (name) => {
      const owner = event()
      await start(owner, request)
      const signal = state.fetch.mock.calls[0][1].signal as AbortSignal
      owner.callbacks.get(name)!()
      expect(signal.aborted).toBe(true)
      expect(await state.handlers.get(MODEL_TRANSPORT_IPC.pull)!(owner, request.id)).toHaveProperty(
        'error.name',
        'AbortError'
      )
    }
  )
})
