import { type ImageCanvasBridge, imageCanvasChannels as channels } from '@shared/config/imageCanvas'
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
  recover: (id) => ipcRenderer.invoke(channels.recover, id),
  configure: (providerId, modelId, settings) =>
    ipcRenderer.invoke(channels.configure, { providerId, modelId, settings }),
  remove: (id) => ipcRenderer.invoke(channels.remove, id),
  exportAsset: (id, action) => ipcRenderer.invoke(channels.exportAsset, { id, action }),
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
