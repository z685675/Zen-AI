import {
  type ImageCanvasAppearance,
  type ImageCanvasBridge,
  imageCanvasChannels as channels
} from '@shared/config/imageCanvas'
import { type VideoBridge, videoChannels } from '@shared/config/videoGeneration'
import { contextBridge, ipcRenderer } from 'electron'

// This preload belongs exclusively to the bundled, local canvas. No desktop API,
// filesystem paths, arbitrary HTTP requests, provider URLs or API keys are exposed.
const bridge: ImageCanvasBridge = {
  catalog: () => ipcRenderer.invoke(channels.catalog),
  submit: (input) => ipcRenderer.invoke(channels.submit, input),
  submitBatch: (inputs) => ipcRenderer.invoke(channels.submitBatch, inputs),
  task: (id) => ipcRenderer.invoke(channels.task, id),
  history: () => ipcRenderer.invoke(channels.history),
  historyPage: (cursor, limit) => ipcRenderer.invoke(channels.historyPage, { cursor, limit }),
  asset: (id) => ipcRenderer.invoke(channels.asset, id),
  recover: (id, assetId) => ipcRenderer.invoke(channels.recover, assetId ? { id, assetId } : id),
  configure: (providerId, modelId, settings) =>
    ipcRenderer.invoke(channels.configure, { providerId, modelId, settings }),
  remove: (id) => ipcRenderer.invoke(channels.remove, id),
  exportAsset: (id, action) => ipcRenderer.invoke(channels.exportAsset, { id, action }),
  onAppearance: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, appearance: ImageCanvasAppearance) => callback(appearance)
    ipcRenderer.on(channels.appearance, listener)
    return () => ipcRenderer.removeListener(channels.appearance, listener)
  },
  flush: (callback) => {
    const listener = async () => {
      await callback()
      ipcRenderer.send(channels.flushed)
    }
    ipcRenderer.on(channels.flush, listener)
    return () => ipcRenderer.removeListener(channels.flush, listener)
  }
}
contextBridge.exposeInMainWorld('imageCanvas', bridge)

const video: VideoBridge = {
  catalog: () => ipcRenderer.invoke(videoChannels.catalog),
  history: () => ipcRenderer.invoke(videoChannels.history),
  submit: (input) => ipcRenderer.invoke(videoChannels.submit, input),
  recover: (id) => ipcRenderer.invoke(videoChannels.recover, id),
  preview: (id) => ipcRenderer.invoke(videoChannels.preview, id),
  save: (id) => ipcRenderer.invoke(videoChannels.save, id),
  remove: (id) => ipcRenderer.invoke(videoChannels.remove, id)
}
contextBridge.exposeInMainWorld('videoWorkbench', video)
