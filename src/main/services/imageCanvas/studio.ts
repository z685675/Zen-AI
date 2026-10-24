import { loggerService } from '@logger'
import type {
  ImageCanvasModel,
  ImageCanvasProgress,
  ImageCanvasProtocol,
  ImageCanvasProvider,
  ImageCanvasRequest,
  ImageCanvasServerDiagnostics,
  ImageCanvasTaskPhase
} from '@shared/config/imageCanvas'
import {
  commonImageDimensions,
  imageDimension,
  imageRatios,
  validateImageCapabilities
} from '@shared/config/imageCapabilities'

import { decodeImage, geminiImageConfig, imageCanvasTimeout, type ImageFetch, limitedBytes } from './protocol'

export type CanvasRemoteJob = {
  origin: string
  submissionId: string
  kind?: 'dashscope' | 'comfyui' | 'results'
  remoteId?: string
  results?: string[]
}
type Capability = {
  revision?: string
  id: string
  protocol: string
  sizes: string[]
  qualities: string[]
  backgrounds: string[]
  max_references: number
  max_images: number
  min_references?: number
  aspect_ratios?: string[]
  supports_mask?: boolean
}
type JobView = {
  job: {
    id?: string
    state: string
    queue_ms?: number
    relay_ms?: number
    archiving_ms?: number
    relay_status?: number
    error_code?: string
    failed_stage?: string
  }
  assets: string[]
  capability?: Pick<Capability, 'protocol' | 'revision'>
}
const serverErrorCodes = new Set([
  'image_resolution_unavailable',
  'generation_failed',
  'generation_timeout',
  'upstream_result_uncertain',
  'execution_interrupted',
  'storage_unavailable',
  'result_capture_failed',
  'image_response_too_large',
  'result_storage_failed',
  'no_image_result',
  'invalid_image_response',
  'image_download_blocked',
  'invalid_image_url',
  'image_download_failed',
  'image_size_limit',
  'unsupported_image',
  'invalid_image'
])

function serverDiagnostics(view: JobView): ImageCanvasServerDiagnostics | undefined {
  const job = view.job
  if (typeof job.id !== 'string' || !/^[a-f0-9-]{36}$/.test(job.id)) return undefined
  const result: ImageCanvasServerDiagnostics = { jobId: job.id, phaseDurationsMs: {} }
  for (const [phase, value] of [
    ['queued', job.queue_ms],
    ['relay', job.relay_ms],
    ['archiving', job.archiving_ms]
  ] as const) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 30 * 24 * 3600000)
      result.phaseDurationsMs[phase] = value
  }
  if (Number.isInteger(job.relay_status) && job.relay_status! >= 100 && job.relay_status! <= 599)
    result.httpStatus = job.relay_status
  if (job.error_code && serverErrorCodes.has(job.error_code)) result.errorCode = job.error_code
  return result
}
const logger = loggerService.withContext('ImageCanvas')
const studioProtocols: Record<string, ImageCanvasProtocol> = {
  images: 'openai',
  'images-json': 'openai-json',
  'images-json-image': 'openai-json',
  gemini: 'gemini',
  seedream: 'seedream',
  chat: 'chat'
}

async function downloadAsset(request: ImageFetch, root: string, id: string, auth: Headers): Promise<Buffer> {
  // Only retry the read of an already generated asset. Never replay a generation POST.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const signal = AbortSignal.timeout(60000)
    let retryable = true
    let status: number | undefined
    let stage = 'request'
    try {
      const response = await request(`${root}/assets/${id}`, {
        method: 'GET',
        headers: auth,
        redirect: 'error',
        credentials: 'omit',
        signal
      })
      status = response.status
      if (!response.ok) {
        retryable = status === 408 || status === 429 || status >= 500
        await response.body?.cancel().catch(() => {})
        throw new Error('studio_download_failed')
      }
      stage = 'body'
      const bytes = Buffer.from(await limitedBytes(response, 20 * 1024 * 1024))
      if (!bytes.length) throw new Error('empty_response')
      return bytes
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'response_too_large'
      const code = tooLarge ? 'result_too_large' : 'studio_download_failed'
      const willRetry = retryable && !tooLarge && attempt < 3
      // Record the failing stage without logging credentials, URLs or response bodies.
      logger.error('Image asset download failed', {
        assetId: id,
        attempt,
        stage,
        status,
        reason: signal.aborted ? 'timeout' : code,
        willRetry
      })
      if (!willRetry) throw new Error(code)
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
    }
  }
  throw new Error('studio_download_failed')
}

function endpoint(provider: ImageCanvasProvider, remote?: CanvasRemoteJob): string {
  const origin = new URL(provider.apiHost.replace(/#$/, '')).origin
  if (remote && (remote.origin !== origin || !/^[a-f0-9-]{36}$/.test(remote.submissionId)))
    throw new Error('studio_job_unavailable')
  return `${origin}/api/image-studio`
}

function headers(provider: ImageCanvasProvider): Headers {
  const result = new Headers(provider.headers)
  const key = provider.apiKey
    .split(/(?<!\\),|\r?\n/)
    .map((value) => value.trim().replace(/\\,/g, ','))
    .find(Boolean)
  if (!key) throw new Error('provider_key_missing')
  result.delete('host')
  result.delete('content-length')
  result.delete('content-type')
  result.set('Authorization', `Bearer ${key}`)
  result.set('X-Image-Studio', '1')
  return result
}

async function json<T>(request: ImageFetch, url: string, headers: Headers, body?: BodyInit): Promise<T> {
  const response = await request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body,
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(30000)
  })
  if (!response.ok) throw new Error(`studio_http_${response.status}`)
  const payload = JSON.parse(new TextDecoder().decode(await limitedBytes(response, 2 * 1024 * 1024)))
  if (payload.success !== true) throw new Error('studio_unavailable')
  return payload.data as T
}

export async function studioModels(provider: ImageCanvasProvider, request: ImageFetch): Promise<ImageCanvasModel[]> {
  const data = await json<{ models: Capability[]; submission_lookup?: boolean }>(
    request,
    `${endpoint(provider)}/bootstrap`,
    headers(provider)
  )
  if (data.submission_lookup !== true) throw new Error('studio_upgrade_required')
  if (!Array.isArray(data.models) || data.models.length > 3000) throw new Error('studio_invalid_result')
  return provider.models.flatMap((configured) => {
    const remote = data.models.find((model) => model.id === configured.id)
    if (!remote || !Object.hasOwn(studioProtocols, remote.protocol)) return []
    const safeList = (list: unknown, allowed: (s: string) => boolean): string[] =>
      Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string' && allowed(s)).slice(0, 40) : []
    const sizes = safeList(remote.sizes, (s) => /^(?:auto|[124]K|[1-9]\d{1,3}x[1-9]\d{1,3})$/.test(s))
    const ratios = safeList(remote.aspect_ratios, (s) => imageRatios.includes(s))
    const dimensions =
      remote.protocol === 'gemini'
        ? ratios.flatMap((ratio) =>
            (sizes.length ? sizes : ['']).map((size) => ({
              ratio,
              size: ratio,
              ...(['1K', '2K', '4K'].includes(size) ? { resolution: size as '1K' | '2K' | '4K' } : {})
            }))
          )
        : sizes.filter((size) => !/^[124]K$/.test(size)).map(imageDimension)
    if (!dimensions.length) dimensions.push({ ratio: 'auto', size: 'auto' })
    return [
      {
        ...configured,
        protocol: studioProtocols[remote.protocol],
        capabilities: {
          dimensions: commonImageDimensions(studioProtocols[remote.protocol], dimensions),
          qualities: safeList(remote.qualities, (s) => ['auto', 'low', 'medium', 'high', 'standard', 'hd'].includes(s)),
          backgrounds: safeList(remote.backgrounds, (s) => ['auto', 'opaque', 'transparent'].includes(s)),
          minReferences: Math.max(0, Math.min(4, Number(remote.min_references) || 0)),
          maxReferences: Math.max(0, Math.min(4, Number(remote.max_references) || 0)),
          maxImages: Math.max(
            1,
            Math.min(remote.protocol.startsWith('images') ? 4 : 1, Number(remote.max_images) || 1)
          ),
          source: 'server' as const,
          supportsMask: remote.supports_mask === true,
          revision:
            typeof remote.revision === 'string' && /^[a-f0-9]{16,64}$/.test(remote.revision)
              ? remote.revision
              : undefined
        }
      }
    ]
  })
}

export async function generateStudioImages(
  provider: ImageCanvasProvider,
  input: ImageCanvasRequest,
  request: ImageFetch,
  accepted: (remote: CanvasRemoteJob) => void,
  progress: ImageCanvasProgress = () => {}
): Promise<Buffer[]> {
  const root = endpoint(provider)
  const auth = headers(provider)
  let capabilities: { models: Capability[]; submission_lookup?: boolean }
  try {
    capabilities = await json(request, `${root}/bootstrap`, auth)
  } catch (error) {
    if (error instanceof Error && error.message === 'studio_http_404') throw new Error('studio_upgrade_required')
    throw error
  }
  if (capabilities.submission_lookup !== true) throw new Error('studio_upgrade_required')
  const model = capabilities.models?.find((model) => model.id === input.modelId)
  if (!model) throw new Error('studio_model_unavailable')
  if (!Object.hasOwn(studioProtocols, model.protocol)) throw new Error('studio_upgrade_required')
  progress('preparing', {
    protocol: studioProtocols[model.protocol],
    capabilityRevision:
      typeof model.revision === 'string' && /^[a-f0-9]{16,64}$/.test(model.revision)
        ? model.revision
        : 'server-unversioned',
    capabilitySource: 'server'
  })
  if (input.references.length > model.max_references || input.references.length < (model.min_references || 0))
    throw new Error('studio_reference_limit')
  if (input.count > model.max_images) throw new Error('studio_parameters_unsupported')
  const declared = provider.models.find((item) => item.id === input.modelId)?.capabilities
  if (declared) validateImageCapabilities(input, declared)
  const nativeGemini = model.protocol === 'gemini'
  const geminiConfig = nativeGemini ? geminiImageConfig(input) : {}
  const legacySizes: Record<string, string> = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' }
  const size = nativeGemini
    ? geminiConfig.imageSize || ''
    : input.size.includes(':')
      ? legacySizes[input.size]
      : input.size || 'auto'
  if (size === undefined) throw new Error('studio_parameters_unsupported')
  const ratio = geminiConfig.aspectRatio
  const chosenSize = size === 'auto' && !model.sizes.includes('auto') ? '' : size
  const quality = !nativeGemini && input.quality && input.quality !== 'auto' ? input.quality : ''
  const background = !nativeGemini && input.background && input.background !== 'auto' ? input.background : ''
  if ((quality && !model.qualities.includes(quality)) || (background && !model.backgrounds.includes(background)))
    throw new Error('studio_parameters_unsupported')
  const assetIds: string[] = []
  for (const reference of [...input.references, ...(input.mask ? [input.mask] : [])]) {
    const image = decodeImage(reference)
    const form = new FormData()
    form.set(
      'image',
      new Blob([new Uint8Array(image.bytes)], { type: image.mime }),
      `reference.${image.mime.split('/')[1]}`
    )
    const asset = await json<{ id: string }>(request, `${root}/assets`, auth, form)
    if (!/^[a-f0-9-]{32,64}$/.test(asset.id)) throw new Error('studio_invalid_result')
    assetIds.push(asset.id)
  }
  const maskAssetId = input.mask ? assetIds.pop() : undefined
  const remote = { origin: new URL(root).origin, submissionId: input.id }
  // Persist the submission identity before POST. A lost response can only trigger
  // status lookup; it never triggers another billable generation request.
  accepted(remote)
  progress('queued')
  const submissionHeaders = new Headers(auth)
  submissionHeaders.set('Content-Type', 'application/json')
  submissionHeaders.set('Idempotency-Key', input.id)
  let initial: JobView | undefined
  try {
    initial = await json<JobView>(
      request,
      `${root}/jobs`,
      submissionHeaders,
      JSON.stringify({
        model: input.modelId,
        prompt: input.prompt,
        n: input.count,
        asset_ids: assetIds,
        ...(maskAssetId ? { mask_asset_id: maskAssetId } : {}),
        ...(chosenSize ? { size: chosenSize } : {}),
        ...(ratio ? { aspect_ratio: ratio } : {}),
        ...(quality ? { quality } : {}),
        ...(background ? { background } : {})
      })
    )
  } catch (error) {
    if (error instanceof Error && /^studio_http_4\d\d$/.test(error.message)) throw error
    // The server may already own this task. Look up the same submission key.
  }
  return readStudioImages(provider, remote, request, initial, progress)
}

export async function readStudioImages(
  provider: ImageCanvasProvider,
  remote: CanvasRemoteJob,
  request: ImageFetch,
  initial?: JobView,
  progress: ImageCanvasProgress = () => {}
): Promise<Buffer[]> {
  const root = endpoint(provider, remote)
  const auth = headers(provider)
  const deadline = Date.now() + imageCanvasTimeout
  let view = initial
  let reportedRevision: string | undefined
  progress('queued')
  while (Date.now() < deadline) {
    if (!view) {
      try {
        view = await json<JobView>(request, `${root}/jobs/by-submission/${remote.submissionId}`, auth)
      } catch (error) {
        if (error instanceof Error && /^studio_http_4\d\d$/.test(error.message)) throw error
        // Retry reads only. The generation POST above is never repeated.
        await new Promise((resolve) => setTimeout(resolve, 2000))
        continue
      }
    }
    const snapshot = view.capability
    const revision =
      snapshot && typeof snapshot.revision === 'string' && /^[a-f0-9]{16,64}$/.test(snapshot.revision)
        ? snapshot.revision
        : undefined
    const capability =
      revision && revision !== reportedRevision && snapshot && Object.hasOwn(studioProtocols, snapshot.protocol)
        ? {
            protocol: studioProtocols[snapshot.protocol],
            capabilityRevision: revision,
            capabilitySource: 'server' as const
          }
        : undefined
    if (capability) reportedRevision = revision
    const server = serverDiagnostics(view)
    const report = (phase: ImageCanvasTaskPhase) => {
      if (server) progress(phase, capability, server)
      else progress(phase, capability)
    }
    if (view.job.state === 'succeeded') {
      if (!Array.isArray(view.assets) || !view.assets.length || view.assets.length > 4)
        throw new Error('studio_invalid_result')
      report('downloading')
      return Promise.all(
        view.assets.map((id) => {
          if (!/^[a-f0-9-]{32,64}$/.test(id)) throw new Error('studio_invalid_result')
          return downloadAsset(request, root, id, auth)
        })
      )
    }
    const failure = ['failed', 'cancelled', 'uncertain', 'storage_failed'].includes(view.job.state)
    if (failure) {
      report(
        ['preparing', 'generating', 'archiving'].includes(view.job.failed_stage || '')
          ? (view.job.failed_stage as ImageCanvasTaskPhase)
          : 'generating'
      )
      if (view.job.state === 'cancelled') throw new Error('studio_server_cancelled')
      if (server?.errorCode) throw new Error('studio_server_' + server.errorCode)
      throw new Error(view.job.state === 'failed' ? 'studio_generation_failed' : 'studio_result_pending')
    }
    if (!['queued', 'running', 'archiving'].includes(view.job.state)) throw new Error('studio_result_pending')
    report(view.job.state === 'running' ? 'generating' : view.job.state === 'archiving' ? 'archiving' : 'queued')
    await new Promise((resolve) => setTimeout(resolve, 2000))
    view = undefined
  }
  throw new Error('studio_result_pending')
}
