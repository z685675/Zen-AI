export const videoRatios = ['16:9', '9:16', '1:1', '21:9', '3:4', 'adaptive'] as const
export type VideoRatio = (typeof videoRatios)[number]
export const videoResolutions = [480, 720, 1080, 2160] as const
export const videoEndpointType = 'openai-video'
export const videoSizePattern = /^[1-9]\d{0,4}x[1-9]\d{0,4}$/

type VideoEndpointDeclaration = {
  id: string
  endpoint_type?: string
  supported_endpoint_types?: readonly string[]
}

export function isVideoOnlyEndpointModel(model: VideoEndpointDeclaration): boolean {
  return (
    model.endpoint_type === videoEndpointType ||
    (!model.endpoint_type &&
      !!model.supported_endpoint_types?.length &&
      model.supported_endpoint_types.every((endpoint) => endpoint === videoEndpointType))
  )
}

export function isVideoEndpointModel(model: VideoEndpointDeclaration): boolean {
  if (model.endpoint_type === videoEndpointType || model.supported_endpoint_types?.includes(videoEndpointType))
    return true
  if (model.endpoint_type && !['openai', 'openai-response'].includes(model.endpoint_type)) return false
  // Older gateway versions don't advertise video. Model settings can mark any alias explicitly.
  return /(?:^|[/:._-])(?:seedance|sora|veo|kling|vidu|hailuo|t2v|i2v)(?:$|[._-]|\d)|(?:^|[/:._-])grok-imagine-video(?:$|[._-])/i.test(
    model.id
  )
}

export type VideoModel = { id: string; name: string }
export type VideoCatalog = Array<{ id: string; name: string; models: VideoModel[] }>
export type VideoRequest = {
  id: string
  providerId: string
  modelId: string
  prompt: string
  size?: string
  seconds?: number
  firstFrame?: string
}
export type VideoDownloadProgress = { receivedBytes: number; totalBytes?: number }
export type VideoTask = Omit<VideoRequest, 'firstFrame'> & {
  /** Kept for the first version of the local history. */
  resolution?: string
  createdAt: string
  status: 'submitting' | 'queued' | 'running' | 'downloading' | 'completed' | 'failed' | 'uncertain'
  recoverable: boolean
  readyToDownload?: boolean
  download?: VideoDownloadProgress
  error?: string
}
export type VideoBridge = {
  catalog: () => Promise<VideoCatalog>
  history: () => Promise<VideoTask[]>
  submit: (input: VideoRequest) => Promise<VideoTask>
  recover: (id: string) => Promise<void>
  preview: (id: string) => Promise<Uint8Array>
  save: (id: string) => Promise<boolean>
  remove: (id: string) => Promise<void>
}

export const videoChannels = {
  catalog: 'video-workbench:catalog',
  history: 'video-workbench:history',
  submit: 'video-workbench:submit',
  recover: 'video-workbench:recover',
  preview: 'video-workbench:preview',
  save: 'video-workbench:save',
  remove: 'video-workbench:remove'
} as const
