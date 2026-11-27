import { copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loggerService } from '@logger'
import {
  type ImageCanvasAppearance,
  type ImageCanvasCatalog,
  imageCanvasChannels as channels,
  imageCanvasMaxBatchTasks,
  type ImageCanvasModelConfiguration,
  type ImageCanvasOpen,
  imageCanvasProtocols,
  type ImageCanvasProvider,
  type ImageCanvasRequest,
  imageViewBounds,
  type LegacyImageRecord
} from '@shared/config/imageCanvas'
import { videoChannels, type VideoRequest } from '@shared/config/videoGeneration'
import { isZenManagedApiHost } from '@shared/config/zenProvider'
import { IpcChannel } from '@shared/IpcChannel'
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

import { fetchPublicHttpsResult } from '../mcpServers/publicWebNetwork'
import { importLegacyImages } from './imageCanvas/legacyImages'
import { ImageModelConfiguration } from './imageCanvas/ModelConfiguration'
import type { ImageFetch } from './imageCanvas/protocol'
import { studioModels } from './imageCanvas/studio'
import { createStudioDownloadFetch } from './imageCanvas/studioTransport'
import { ImageCanvasTaskStore } from './imageCanvas/TaskStore'
import { VideoTasks } from './imageCanvas/VideoTasks'
import { routeManagedFetch } from './modelTransport/apiFetch'

const logger = loggerService.withContext('ImageCanvas')
function canvasAppearance(input: ImageCanvasAppearance = {}): Required<ImageCanvasAppearance> {
  return {
    theme: input.theme === 'dark' ? 'dark' : 'light',
    themePreset: input.themePreset === 'zen-paper' ? 'zen-paper' : 'codex',
    language: typeof input.language === 'string' ? input.language.slice(0, 20) : 'zh-CN',
    userFontFamily: typeof input.userFontFamily === 'string' ? input.userFontFamily.slice(0, 500) : ''
  }
}
let tasks: ImageCanvasTaskStore | undefined
let videos: VideoTasks | undefined

export class ImageCanvasService {
  private view?: WebContentsView
  private providers: ImageCanvasProvider[] = []
  private closing?: Promise<void>
  private importing = Promise.resolve(0)
  private readonly page = join(__dirname, '../../resources/image-workbench/index.html')
  private configuration?: ImageModelConfiguration
  private readonly catalogs = new Map<string, { expires: number; value: Promise<ImageCanvasProvider> }>()
  private readonly downloadFetch: typeof fetch = createStudioDownloadFetch(
    (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
    (url) => session.defaultSession.resolveProxy(url)
  )
  private readonly apiRequest = routeManagedFetch(this.downloadFetch)
  private readonly request: ImageFetch = (input, init) => {
    if (init?.publicImageResult) {
      if (typeof input !== 'string' && !(input instanceof URL)) throw new Error('invalid_result_url')
      return fetchPublicHttpsResult(input, init.signal)
    }
    return this.apiRequest(input, init)
  }

  constructor(private readonly window: BrowserWindow) {
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
      if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > imageCanvasMaxBatchTasks)
        throw new Error('invalid_request')
      const providers = await Promise.all(inputs.map((input) => this.readyProvider(input?.providerId)))
      return this.store().submitBatch(providers, inputs)
    })
    handle(channels.task, (id) => this.store().task(this.validId(id)))
    handle(channels.history, () => this.store().history())
    handle(channels.historyPage, (input) => this.store().historyPage(input?.cursor, input?.limit))
    handle(channels.asset, (id) => this.store().asset(this.validId(id)))
    handle(channels.recover, (input) => {
      const id = this.validId(typeof input === 'string' ? input : input?.id)
      const assetId = input?.assetId === undefined ? undefined : this.validId(input.assetId)
      const task = this.store().task(id)
      const provider = this.providers.find((provider) => provider.id === task?.providerId)
      if (!provider) throw new Error('provider_unavailable')
      return this.store().recover(provider, id, assetId)
    })
    handle(channels.remove, (id) => this.store().remove(this.validId(id)))
    handle(videoChannels.catalog, () =>
      this.providers
        .filter((provider) => provider.videoModels?.length)
        .map(({ id, name, videoModels }) => ({ id, name, models: videoModels }))
    )
    handle(videoChannels.history, () => this.videoStore().history())
    handle(videoChannels.submit, (input: VideoRequest) => {
      this.validId(input?.id)
      const provider = this.providers.find(
        (provider) =>
          provider.id === input.providerId && provider.videoModels?.some((model) => model.id === input.modelId)
      )
      if (!provider) throw new Error('model_unavailable')
      return this.videoStore().submit(provider, input)
    })
    handle(videoChannels.recover, (value) => {
      const id = this.validId(value)
      const task = this.videoStore()
        .history()
        .find((task) => task.id === id)
      const provider = this.providers.find((provider) => provider.id === task?.providerId)
      if (!provider) throw new Error('provider_unavailable')
      return this.videoStore().recover(provider, id)
    })
    handle(videoChannels.preview, (id) => this.videoStore().preview(this.validId(id)))
    handle(videoChannels.remove, (id) => this.videoStore().remove(this.validId(id)))
    handle(videoChannels.save, async (value) => {
      const id = this.validId(value)
      const source = this.videoStore().file(id)
      const target = await dialog.showSaveDialog(this.window, {
        defaultPath: `Zen-AI-${id}.mp4`,
        filters: [{ name: 'MP4', extensions: ['mp4'] }]
      })
      if (target.canceled || !target.filePath) return false
      await copyFile(source, target.filePath)
      return true
    })
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
    const acknowledgeFlush = (event: Electron.IpcMainEvent) => {
      if (authorized(event)) this.resolveFlush?.()
    }
    ipcMain.on(channels.flushed, acknowledgeFlush)
    window.once('closed', () => {
      ipcMain.off(channels.flushed, acknowledgeFlush)
      this.resolveFlush?.()
      this.view?.webContents.close()
      this.view = undefined
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

  private videoStore(): VideoTasks {
    videos ??= new VideoTasks(join(app.getPath('userData'), 'Data', 'video-workbench'), this.apiRequest)
    return videos
  }

  importLegacy(
    records: LegacyImageRecord[],
    readStoredFile: (name: string, maxBytes: number) => Promise<Buffer>
  ): Promise<number> {
    const operation = this.importing
      .catch(() => 0)
      .then(() => importLegacyImages(this.store(), records, readStoredFile))
    this.importing = operation
    return operation
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
      this.providers
        .filter((provider) => provider.models.length)
        .map(async (provider) => {
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
        (provider.videoModels !== undefined &&
          (!Array.isArray(provider.videoModels) ||
            provider.videoModels.length > 2000 ||
            provider.videoModels.some(
              (model) =>
                !model ||
                typeof model.id !== 'string' ||
                !model.id.trim() ||
                model.id.length > 1024 ||
                typeof model.name !== 'string' ||
                model.name.length > 500
            ))) ||
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
    try {
      if (videos || this.providers.some((provider) => provider.videoModels?.length))
        this.videoStore().resume(this.providers)
    } catch {
      logger.error('Could not load video history')
    }
    this.view?.webContents.send(channels.flush)
  }

  async open(input: ImageCanvasOpen): Promise<{ ok: boolean }> {
    try {
      await this.close()
      this.sync(input.providers)
      this.store()
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
      view.setVisible(false)
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      view.webContents.on('will-navigate', (event) => event.preventDefault())
      view.webContents.on('will-redirect', (event) => event.preventDefault())
      view.webContents.on('before-input-event', (event, input) => {
        const primaryModifier =
          process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
        if (input.type !== 'keyDown' || input.code !== 'KeyB' || !primaryModifier || input.alt || input.shift) return
        event.preventDefault()
        if (!input.isAutoRepeat && !this.window.isDestroyed()) {
          this.window.webContents.send(IpcChannel.Windows_ToggleSidebar)
        }
      })
      this.resize(input.bounds)
      const { userFontFamily: fontFamily, ...appearance } = canvasAppearance(input)
      await view.webContents.loadFile(this.page, {
        hash: new URLSearchParams({
          ...appearance,
          fontFamily,
          os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'
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
    const bounds = imageViewBounds(input)
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

  setAppearance(input: ImageCanvasAppearance): void {
    const view = this.view
    if (!view || view.webContents.isDestroyed() || !input || typeof input !== 'object') return
    view.webContents.send(channels.appearance, canvasAppearance(input))
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
