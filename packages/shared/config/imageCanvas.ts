import type { ImageStudioBounds } from './imageStudio'

export const imageCanvasProtocols = [
  'openai',
  'openai-json',
  'chat',
  'gemini',
  'seedream',
  'dashscope',
  'comfyui'
] as const
export type ImageCanvasProtocol = (typeof imageCanvasProtocols)[number]
export type ImageCanvasExpansion = { top: number; right: number; bottom: number; left: number }
export type ImageCanvasDimension = { ratio: string; size: string; resolution?: '1K' | '2K' | '4K' }
export type ImageCanvasCapabilities = {
  dimensions: ImageCanvasDimension[]
  qualities: string[]
  backgrounds: string[]
  minReferences: number
  maxReferences: number
  maxImages: number
  source: 'builtin' | 'server' | 'custom'
  revision?: string
  supportsMask?: boolean
}
export type ImageCanvasModel = {
  id: string
  name: string
  protocol: ImageCanvasProtocol
  capabilities?: ImageCanvasCapabilities
  configuration?: ImageCanvasModelConfiguration
}
export type ImageCanvasProvider = {
  id: string
  name: string
  apiHost: string
  apiKey: string
  headers?: Record<string, string>
  models: ImageCanvasModel[]
}
export type ImageCanvasCatalog = Array<{ id: string; name: string; models: ImageCanvasModel[]; error?: string }>
export type ImageCanvasRequest = {
  id: string
  providerId: string
  modelId: string
  prompt: string
  references: string[]
  size: string
  resolution?: '1K' | '2K' | '4K'
  aspectRatio?: string
  quality: string
  background: string
  count: number
  mask?: string
  expansion?: ImageCanvasExpansion
  batchId?: string
}
export type ImageCanvasTaskPhase =
  | 'preparing'
  | 'queued'
  | 'generating'
  | 'archiving'
  | 'downloading'
  | 'decoding'
  | 'saving'
export type ImageCanvasTaskDiagnostics = {
  protocol: ImageCanvasProtocol
  capabilityRevision: string
  capabilitySource: ImageCanvasCapabilities['source']
  attempts: number
  phaseDurationsMs: Partial<Record<ImageCanvasTaskPhase, number>>
  finishedAt?: string
  failedPhase?: ImageCanvasTaskPhase
  server?: ImageCanvasServerDiagnostics
}
export type ImageCanvasServerDiagnostics = {
  jobId: string
  phaseDurationsMs: Partial<Record<'queued' | 'relay' | 'archiving', number>>
  httpStatus?: number
  errorCode?: string
}
export type ImageCanvasProgress = (
  phase: ImageCanvasTaskPhase,
  capability?: Pick<ImageCanvasTaskDiagnostics, 'protocol' | 'capabilityRevision' | 'capabilitySource'>,
  server?: ImageCanvasServerDiagnostics
) => void
export type ImageCanvasTask = {
  outputSizes?: string[]
  id: string
  providerId: string
  modelId: string
  prompt: string
  createdAt: string
  status: 'running' | 'completed' | 'failed' | 'uncertain'
  assets: string[]
  error?: string
  recoverable?: boolean
  phase?: ImageCanvasTaskPhase
  diagnostics?: ImageCanvasTaskDiagnostics
  providerName?: string
  modelName?: string
  parameters?: Omit<ImageCanvasRequest, 'id' | 'providerId' | 'modelId' | 'prompt' | 'references' | 'mask'>
  referenceAssets?: string[]
  maskAsset?: string
  batchId?: string
}
export type ImageCanvasModelConfiguration = {
  protocol: ImageCanvasProtocol
  sizes: string[]
  ratios: string[]
  resolutions: Array<'1K' | '2K' | '4K'>
  qualities: string[]
  backgrounds: string[]
  minReferences: number
  maxReferences: number
  maxImages: number
  supportsMask?: boolean
  imageField?: 'image' | 'images'
  workflow?: string
}
export type ImageCanvasHistoryPage = { items: ImageCanvasTask[]; total: number; nextCursor?: string }
export type ImageCanvasBridge = {
  catalog: () => Promise<ImageCanvasCatalog>
  submit: (input: ImageCanvasRequest) => Promise<ImageCanvasTask>
  submitBatch?: (inputs: ImageCanvasRequest[]) => Promise<ImageCanvasTask[]>
  task: (id: string) => Promise<ImageCanvasTask | undefined>
  history: () => Promise<ImageCanvasTask[]>
  historyPage?: (cursor?: string, limit?: number) => Promise<ImageCanvasHistoryPage>
  asset: (id: string) => Promise<string>
  recover: (id: string) => Promise<ImageCanvasTask>
  configure: (providerId: string, modelId: string, settings: ImageCanvasModelConfiguration | null) => Promise<void>
  remove: (id: string) => Promise<void>
  exportAsset: (id: string, action: 'save' | 'copy') => Promise<boolean>
  flush: (callback: () => Promise<void>) => () => void
}
export type ImageCanvasOpen = {
  bounds: ImageStudioBounds
  providers: ImageCanvasProvider[]
  surface?: 'canvas' | 'workbench'
  theme?: 'light' | 'dark'
  language?: string
  userFontFamily?: string
}

export const imageCanvasChannels = {
  control: 'image-canvas:control',
  catalog: 'image-canvas:catalog',
  submit: 'image-canvas:submit',
  submitBatch: 'image-canvas:submit-batch',
  task: 'image-canvas:task',
  history: 'image-canvas:history',
  historyPage: 'image-canvas:history-page',
  asset: 'image-canvas:asset',
  recover: 'image-canvas:recover',
  configure: 'image-canvas:configure',
  remove: 'image-canvas:remove',
  exportAsset: 'image-canvas:export',
  flush: 'image-canvas:flush',
  flushed: 'image-canvas:flushed'
} as const
