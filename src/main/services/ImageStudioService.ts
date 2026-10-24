import { createHash } from 'node:crypto'

import { imageStudioBounds, type ImageStudioOpen, imageStudioOrigin } from '@shared/config/imageStudio'
import type { BrowserWindow } from 'electron'
import { net, session, WebContentsView } from 'electron'

// This remote view deliberately has no preload and no Node/desktop bridge.
// File picking and saving use Chromium's native, user-initiated dialogs.
export class ImageStudioService {
  private view?: WebContentsView
  private generation = 0

  constructor(private readonly window: BrowserWindow) {
    window.once('closed', () => this.close())
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.close()
    })
  }

  close(): void {
    this.generation++
    if (!this.view) return
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(this.view)
    this.view.webContents.close()
    this.view = undefined
  }

  resize(bounds: ImageStudioOpen['bounds']): void {
    const zoom = this.window.webContents.getZoomFactor()
    const rect = imageStudioBounds(bounds)
    this.view?.setBounds({
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.round(rect.width * zoom),
      height: Math.round(rect.height * zoom)
    })
  }

  setVisible(visible: boolean): void {
    if (typeof visible === 'boolean') this.view?.setVisible(visible)
  }

  async open(input: ImageStudioOpen): Promise<{ ok: boolean }> {
    this.close()
    const generation = this.generation
    try {
      const origin = imageStudioOrigin(input.apiHost)
      const bounds = imageStudioBounds(input.bounds)
      if (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 64000) return { ok: false }
      const response = await net.fetch(`${origin}/api/image-studio/handoff`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${input.apiKey}`, 'X-Image-Studio': '1' }
      })
      if (!response.ok) return { ok: false }
      const data = (await response.json()) as { success?: boolean; data?: { code?: string } }
      const code = data.data?.code
      if (
        !data.success ||
        typeof code !== 'string' ||
        !/^[a-f0-9]{64}$/.test(code) ||
        generation !== this.generation ||
        this.window.isDestroyed()
      )
        return { ok: false }
      const scope = createHash('sha256').update(`${origin}\n${input.apiKey}`).digest('hex')
      const isolated = session.fromPartition(`persist:image-studio-${scope}`)
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      isolated.setPermissionCheckHandler(() => false)
      // Restrict downloads to protected workspace assets. Never honor arbitrary
      // remote filenames or save paths supplied by a page.
      isolated.removeAllListeners('will-download')
      isolated.on('will-download', (event, item) => {
        const url = new URL(item.getURL())
        if (url.origin !== origin || !/^\/api\/image-studio\/assets\/[a-f0-9-]{32,64}$/.test(url.pathname)) {
          event.preventDefault()
          return
        }
        const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
        const extension = extensions[item.getMimeType()]
        if (!extension) {
          event.preventDefault()
          return
        }
        item.setSaveDialogOptions({ defaultPath: `${url.pathname.split('/').pop()}.${extension}` })
      })
      const view = new WebContentsView({
        webPreferences: {
          session: isolated,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          allowRunningInsecureContent: false
        }
      })
      this.view = view
      view.setVisible(false)
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      view.webContents.on('will-navigate', (event, target) => {
        if (new URL(target).origin !== origin) event.preventDefault()
      })
      view.webContents.on('will-redirect', (event, target) => {
        if (new URL(target).origin !== origin) event.preventDefault()
      })
      this.resize(bounds)
      await view.webContents.loadURL(`${origin}/studio/images#handoff=${code}`)
      if (generation === this.generation && !this.window.isDestroyed()) this.window.contentView.addChildView(view)
      return { ok: generation === this.generation }
    } catch {
      if (generation === this.generation) this.close()
      return { ok: false }
    }
  }
}
