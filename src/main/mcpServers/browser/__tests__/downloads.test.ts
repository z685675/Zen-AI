import { EventEmitter } from 'node:events'
import fs from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const downloadRoot = '/mock/downloads'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => downloadRoot)
  }
}))

import { BrowserDownloadManager } from '../downloads'

function createSession() {
  return {
    on: vi.fn(),
    removeListener: vi.fn()
  } as any
}

function createDownloadItem() {
  const item = new EventEmitter() as EventEmitter & Record<string, any>
  let savePath = ''
  item.getFilename = vi.fn(() => 'paper.pdf')
  item.getURL = vi.fn(() => 'https://example.com/paper.pdf')
  item.getMimeType = vi.fn(() => 'application/pdf')
  item.getReceivedBytes = vi.fn(() => 1024)
  item.getTotalBytes = vi.fn(() => 1024)
  item.setSavePath = vi.fn((value: string) => {
    savePath = value
  })
  Object.defineProperty(item, 'savePath', { get: () => savePath })
  return item
}

afterEach(() => {
  vi.clearAllMocks()
})

beforeEach(() => {
  vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as any)
})

describe('BrowserDownloadManager', () => {
  it('tracks only downloads belonging to the current browser controller', async () => {
    const session = createSession()
    const manager = new BrowserDownloadManager((webContentsId) =>
      webContentsId === 7 ? { tabId: 'tab-1', privateMode: false } : undefined
    )
    manager.attachSession(session)
    const handler = session.on.mock.calls[0][1]
    const item = createDownloadItem()

    handler({}, item, { id: 99 })
    expect(manager.list()).toHaveLength(0)

    handler({}, item, { id: 7 })
    const started = manager.list()[0]
    expect(started).toMatchObject({ tabId: 'tab-1', state: 'in_progress', mimeType: 'application/pdf' })
    expect(item.setSavePath).toHaveBeenCalled()
  })

  it('waits for a completed download and returns its saved path', async () => {
    const session = createSession()
    const manager = new BrowserDownloadManager(() => ({ tabId: 'tab-1', privateMode: false }))
    manager.attachSession(session)
    const handler = session.on.mock.calls[0][1]
    const item = createDownloadItem()

    handler({}, item, { id: 7 })
    const started = manager.list()[0]
    const wait = manager.waitForDownload({ downloadId: started.id, timeoutMs: 1000 })
    item.emit('done', {}, 'completed')

    await expect(wait).resolves.toMatchObject({ id: started.id, state: 'completed', path: item.savePath })
  })
})
