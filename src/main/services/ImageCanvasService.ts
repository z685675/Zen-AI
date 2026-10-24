import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loggerService } from '@logger'
import {
  type ImageCanvasCatalog,
  imageCanvasChannels as channels,
  type ImageCanvasModelConfiguration,
  type ImageCanvasOpen,
  imageCanvasProtocols,
  type ImageCanvasProvider,
  type ImageCanvasRequest
} from '@shared/config/imageCanvas'
import { imageStudioBounds } from '@shared/config/imageStudio'
import { isZenManagedApiHost } from '@shared/config/zenProvider'
import {
  app,
  type BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  net,
  session,
  WebContentsView
} from 'electron'

import { ImageModelConfiguration } from './imageCanvas/ModelConfiguration'
import { studioModels } from './imageCanvas/studio'
import { ImageCanvasTaskStore } from './imageCanvas/TaskStore'

const logger = loggerService.withContext('ImageCanvas')
let tasks: ImageCanvasTaskStore | undefined

export class ImageCanvasService {
  private view?: WebContentsView
  private providers: ImageCanvasProvider[] = []
  private closing?: Promise<void>
  private page = join(__dirname, '../../resources/image-canvas/index.html')
  private configuration?: ImageModelConfiguration
  private readonly catalogs = new Map<string, { expires: number; value: Promise<ImageCanvasProvider> }>()
  private readonly request: typeof fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, init)

  constructor(private readonly window: BrowserWindow) {
    window.once('closed', () => {
      this.view?.webContents.close()
      this.view = undefined
    })
    const authorized = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) =>
      this.view &&
      event.sender === this.view.webContents &&
      event.senderFrame === event.sender.mainFrame &&
      event.senderFrame?.url.split('#')[0] === pathToFileURL(this.page).href
    const handle = (channel: string, handler: (input: any) => unknown) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (event, input) => {
        if (!authorized(event)) throw new Error('invalid_canvas_sender')
        return handler(input)
      })
    }
    handle(channels.catalog, () => {
      this.catalogs.clear()
      return this.catalog()
    })
    handle(channels.submit, async (input: ImageCanvasRequest) => {
      const provider = await this.readyProvider(input?.providerId)
      return this.store().submit(provider, input)
    })
    handle(channels.submitBatch, async (inputs: ImageCanvasRequest[]) => {
      if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > 4) throw new Error('invalid_request')
      const providers = await Promise.all(inputs.map((input) => this.readyProvider(input?.providerId)))
      return this.store().submitBatch(providers, inputs)
    })
    handle(channels.task, (id) => this.store().task(this.validId(id)))
    handle(channels.history, () => this.store().history())
    handle(channels.historyPage, (input) => this.store().historyPage(input?.cursor, input?.limit))
    handle(channels.asset, (id) => this.store().asset(this.validId(id)))
    handle(channels.recover, (id) => {
      const task = this.store().task(this.validId(id))
      const provider = this.providers.find((provider) => provider.id === task?.providerId)
      if (!provider) throw new Error('provider_unavailable')
      return this.store().recover(provider, id)
    })
    handle(channels.remove, (id) => this.store().remove(this.validId(id)))
    handle(
      channels.configure,
      (input: { providerId: string; modelId: string; settings: ImageCanvasModelConfiguration | null }) => {
        const provider = this.providers.find((item) => item.id === input?.providerId)
        if (!provider) throw new Error('provider_unavailable')
        if (isZenManagedApiHost(provider.apiHost)) throw new Error('server_managed_capabilities')
        this.config().configure(provider, input.modelId, input.settings)
        this.catalogs.clear()
      }
    )
    handle(channels.exportAsset, async (input: { id: string; action: string }) => {
      const data = await this.store().asset(this.validId(input?.id))
      if (input.action === 'copy') {
        clipboard.writeImage(nativeImage.createFromDataURL(data))
        return true
      }
      if (input.action !== 'save') throw new Error('invalid_export_action')
      const result = await dialog.showSaveDialog(this.window, {
        defaultPath: `Zen-AI-${input.id}.png`,
        filters: [{ name: 'PNG', extensions: ['png'] }]
      })
      if (result.canceled || !result.filePath) return false
      const image = nativeImage.createFromDataURL(data)
      if (image.isEmpty()) throw new Error('invalid_result_image')
      await writeFile(result.filePath, image.toPNG())
      return true
    })
    // Install before the first page is opened; unauthenticated frames cannot acknowledge a flush.
    ipcMain.on(channels.flushed, (event) => {
      if (authorized(event)) this.resolveFlush?.()
    })
  }

  private resolveFlush?: () => void

  private validId(id: unknown): string {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid_id')
    return id
  }

  private store(): ImageCanvasTaskStore {
    tasks ??= new ImageCanvasTaskStore(join(app.getPath('userData'), 'Data', 'image-canvas'), this.request)
    return tasks
  }

  private config(): ImageModelConfiguration {
    this.configuration ??= new ImageModelConfiguration(join(app.getPath('userData'), 'Data', 'image-canvas'))
    return this.configuration
  }

  private async readyProvider(id: string): Promise<ImageCanvasProvider> {
    const provider = this.providers.find((item) => item.id === id)
    if (!provider) throw new Error('provider_unavailable')
    if (!isZenManagedApiHost(provider.apiHost)) return this.config().apply(provider)
    const cache = this.catalogs.get(id)
    if (cache && cache.expires > Date.now()) return cache.value
    const value = studioModels(structuredClone(provider), this.request).then((models) => ({ ...provider, models }))
    this.catalogs.set(id, { expires: Date.now() + 30_000, value })
    try {
      return await value
    } catch (error) {
      this.catalogs.delete(id)
      throw error
    }
  }

  private async catalog(): Promise<ImageCanvasCatalog> {
    return Promise.all(
      this.providers.map(async (provider) => {
        try {
          const { id, name, models } = await this.readyProvider(provider.id)
          return { id, name, models }
        } catch (error) {
          const message = error instanceof Error ? error.message : ''
          return {
            id: provider.id,
            name: provider.name,
            models: [],
            error: /^(?:studio_upgrade_required|studio_http_\d{3}|provider_key_missing)$/.test(message)
              ? message
              : 'catalog_unavailable'
          }
        }
      })
    )
  }

  sync(input: ImageCanvasProvider[]): void {
    if (!Array.isArray(input) || input.length > 300) throw new Error('invalid_providers')
    for (const provider of input) {
      if (
        !provider ||
        typeof provider.id !== 'string' ||
        provider.id.length > 300 ||
        typeof provider.name !== 'string' ||
        provider.name.length > 500 ||
        typeof provider.apiHost !== 'string' ||
        provider.apiHost.length > 4000 ||
        typeof provider.apiKey !== 'string' ||
        provider.apiKey.length > 64000 ||
        !Array.isArray(provider.models) ||
        provider.models.length > 2000 ||
        provider.models.some(
          (model) =>
            !model ||
            typeof model.id !== 'string' ||
            model.id.length > 300 ||
            typeof model.name !== 'string' ||
            !imageCanvasProtocols.includes(model.protocol)
        ) ||
        (provider.headers &&
          (typeof provider.headers !== 'object' ||
            Object.entries(provider.headers).some(
              ([key, value]) =>
                !/^[\w-]{1,100}$/.test(key) || typeof value !== 'string' || value.length > 8000 || /[\r\n]/.test(value)
            )))
      )
        throw new Error('invalid_provider')
      const url = new URL(provider.apiHost.replace(/#$/, ''))
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('invalid_provider_url')
    }
    // The renderer supplies configured identities, never trusted capability data.
    this.providers = input.map((provider) => ({
      ...structuredClone(provider),
      models: provider.models.map(({ id, name, protocol }) => ({ id, name, protocol }))
    }))
    this.catalogs.clear()
    this.view?.webContents.send(channels.flush)
  }

  async open(input: ImageCanvasOpen): Promise<{ ok: boolean }> {
    try {
      await this.close()
      this.sync(input.providers)
      this.store()
      if (input.surface !== undefined && !['canvas', 'workbench'].includes(input.surface))
        throw new Error('invalid_surface')
      this.page = join(
        __dirname,
        input.surface === 'workbench'
          ? '../../resources/image-workbench/index.html'
          : '../../resources/image-canvas/index.html'
      )
      const isolated = session.fromPartition('persist:zen-image-canvas')
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      isolated.setPermissionCheckHandler(() => false)
      // The page has no reason to access the network. Generation goes through main.
      isolated.webRequest.onBeforeRequest((details, callback) => {
        const local = details.url.startsWith(pathToFileURL(join(this.page, '..')).href + '/')
        callback({ cancel: !local && !/^(?:data|blob):/.test(details.url) })
      })
      const view = new WebContentsView({
        webPreferences: {
          session: isolated,
          preload: join(__dirname, '../preload/imageCanvas.js'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true
        }
      })
      this.view = view
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      view.webContents.on('will-navigate', (event) => event.preventDefault())
      view.webContents.on('will-redirect', (event) => event.preventDefault())
      this.resize(input.bounds)
      await view.webContents.loadFile(this.page, {
        hash: new URLSearchParams({
          theme: input.theme === 'dark' ? 'dark' : 'light',
          language: typeof input.language === 'string' ? input.language.slice(0, 20) : 'zh-CN',
          os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux',
          fontFamily: typeof input.userFontFamily === 'string' ? input.userFontFamily.slice(0, 500) : ''
        }).toString()
      })
      if (this.window.isDestroyed() || this.view !== view) return { ok: false }
      this.window.contentView.addChildView(view)
      return { ok: true }
    } catch (error) {
      logger.error(
        'Could not open local image canvas',
        error instanceof Error ? error : new Error('canvas_open_failed')
      )
      await this.close()
      return { ok: false }
    }
  }

  resize(input: ImageCanvasOpen['bounds']): void {
    const bounds = imageStudioBounds(input)
    const zoom = this.window.webContents.getZoomFactor()
    this.view?.setBounds({
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.round(bounds.width * zoom),
      height: Math.round(bounds.height * zoom)
    })
  }

  setVisible(visible: boolean): void {
    if (typeof visible === 'boolean') this.view?.setVisible(visible)
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing
    const view = this.view
    if (!view) return
    view.setVisible(false)
    this.closing = (async () => {
      if (!view.webContents.isDestroyed()) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 1500)
          this.resolveFlush = () => {
            clearTimeout(timeout)
            resolve()
          }
          view.webContents.send(channels.flush)
        })
        this.resolveFlush = undefined
        if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view)
        view.webContents.close()
      }
      if (this.view === view) this.view = undefined
    })()
    try {
      await this.closing
    } finally {
      this.closing = undefined
    }
  }
}
