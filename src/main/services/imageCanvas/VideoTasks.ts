import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

import { loggerService } from '@logger'
import type { ImageCanvasProvider } from '@shared/config/imageCanvas'
import {
  type VideoDownloadProgress,
  type VideoRequest,
  videoSizePattern,
  type VideoTask
} from '@shared/config/videoGeneration'
import { splitApiKeyString } from '@shared/utils/apiKeys'

import { decodeImage, imageEndpoint } from './protocol'

const logger = loggerService.withContext('VideoTasks')
const maxVideoBytes = 150 * 1024 * 1024
const maxActive = 2
const taskIdPattern = /^(?!\.{1,2}$)[a-zA-Z0-9_.:~-]{1,512}$/
type StoredTask = Omit<VideoTask, 'download'> & {
  binding: string
  fingerprint: string
  remoteId?: string
  replaceDownload?: boolean
}
type ProviderConnection = { base: string; headers: Headers; binding: string }
type VideoSubmission = { multipart: FormData; json: () => string }
type VideoResult = { id?: string; task_id?: string; status?: string }
type VideoResponse = VideoResult & { data?: VideoResult }

export function videoConnection(provider: ImageCanvasProvider): ProviderConnection {
  const base = imageEndpoint(provider.apiHost, 'openai', '')
  const key = splitApiKeyString(provider.apiKey)[0]
  if (!key) throw new Error('provider_key_missing')
  const headers = new Headers(provider.headers)
  headers.delete('host')
  headers.delete('content-length')
  headers.set('authorization', `Bearer ${key}`)
  headers.set('content-type', 'application/json')
  const binding = createHash('sha256')
    .update(JSON.stringify([base, [...headers]]))
    .digest('hex')
  return { base, headers, binding }
}

function videoRequest(input: VideoRequest): { body: VideoSubmission; fingerprint: string } {
  if (
    typeof input.modelId !== 'string' ||
    !input.modelId.trim() ||
    typeof input.prompt !== 'string' ||
    !input.prompt.trim() ||
    input.prompt.length > 5000 ||
    (input.size !== undefined && (typeof input.size !== 'string' || !videoSizePattern.test(input.size))) ||
    (input.seconds !== undefined && (!Number.isSafeInteger(input.seconds) || input.seconds < 1))
  )
    throw new Error('video_parameters_unsupported')
  const fields: Record<string, string> = { model: input.modelId, prompt: input.prompt.trim() }
  if (input.size !== undefined) fields.size = input.size
  if (input.seconds !== undefined) fields.seconds = String(input.seconds)
  const multipart = new FormData()
  for (const [key, value] of Object.entries(fields)) multipart.set(key, value)
  if (input.firstFrame !== undefined) {
    if (typeof input.firstFrame !== 'string') throw new Error('invalid_image')
    const { bytes, mime } = decodeImage(input.firstFrame)
    multipart.set('input_reference', new Blob([new Uint8Array(bytes)], { type: mime }), `frame.${mime.split('/')[1]}`)
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([input.modelId, input.prompt.trim(), input.size, input.seconds, input.firstFrame]))
    .digest('hex')
  return {
    body: { multipart, json: () => JSON.stringify({ ...fields, input_reference: input.firstFrame }) },
    fingerprint
  }
}

function publicTask(task: StoredTask, download?: VideoDownloadProgress): VideoTask {
  return {
    id: task.id,
    providerId: task.providerId,
    modelId: task.modelId,
    prompt: task.prompt,
    resolution: task.resolution,
    size: task.size,
    seconds: task.seconds,
    createdAt: task.createdAt,
    status: task.status,
    recoverable: task.recoverable || (task.status === 'completed' && !!task.remoteId),
    readyToDownload: task.readyToDownload,
    download: download && { ...download },
    error: task.error
  }
}

export class VideoTasks {
  private readonly index: string
  private readonly entries: StoredTask[]
  private readonly active = new Set<string>()
  private readonly downloads = new Map<string, VideoDownloadProgress>()

  constructor(
    private readonly directory: string,
    private readonly request: typeof fetch
  ) {
    mkdirSync(directory, { recursive: true })
    this.index = join(directory, 'tasks.json')
    const records: StoredTask[] = existsSync(this.index) ? JSON.parse(readFileSync(this.index, 'utf8')) : []
    if (!Array.isArray(records) || records.some((task) => !task || !/^[a-f0-9-]{36}$/.test(task.id)))
      throw new Error('invalid_video_index')
    this.entries = records.map((task) =>
      task.status === 'submitting'
        ? { ...task, status: 'uncertain', error: 'submit_uncertain', recoverable: false }
        : task
    )
  }

  history(): VideoTask[] {
    return this.entries.map((task) => publicTask(task, this.downloads.get(task.id)))
  }

  private persist(): void {
    writeFileSync(`${this.index}.tmp`, JSON.stringify(this.entries), { mode: 0o600 })
    renameSync(`${this.index}.tmp`, this.index)
  }

  private task(id: string): StoredTask {
    const task = this.entries.find((entry) => entry.id === id)
    if (!task) throw new Error('video_task_unavailable')
    return task
  }

  private update(task: StoredTask, patch: Partial<StoredTask>): void {
    Object.assign(task, patch)
    this.persist()
  }

  submit(provider: ImageCanvasProvider, input: VideoRequest): VideoTask {
    const { body, fingerprint: requestFingerprint } = videoRequest(input)
    const connection = videoConnection(provider)
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([connection.binding, requestFingerprint]))
      .digest('hex')
    const previous = this.entries.find((task) => task.id === input.id)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('request_id_conflict')
      return publicTask(previous)
    }
    if (this.active.size >= maxActive) throw new Error('too_many_tasks')
    const task: StoredTask = {
      id: input.id,
      providerId: input.providerId,
      modelId: input.modelId,
      prompt: input.prompt,
      size: input.size,
      seconds: input.seconds,
      createdAt: new Date().toISOString(),
      status: 'submitting',
      recoverable: false,
      fingerprint,
      binding: connection.binding
    }
    this.entries.unshift(task)
    try {
      this.persist()
    } catch (error) {
      this.entries.shift()
      throw error
    }
    this.start(task, connection, body)
    return publicTask(task)
  }

  recover(provider: ImageCanvasProvider, id: string): void {
    const task = this.task(id)
    if (this.active.has(id)) return
    const refresh = task.status === 'completed'
    if (!task.remoteId || (!task.recoverable && !refresh) || task.status === 'failed')
      throw new Error('video_task_unavailable')
    const connection = videoConnection(provider)
    if (connection.binding !== task.binding) throw new Error('provider_configuration_changed')
    if (this.active.size >= maxActive) throw new Error('too_many_tasks')
    const readyToDownload = task.readyToDownload || refresh
    this.update(task, {
      status: readyToDownload ? 'downloading' : 'queued',
      recoverable: true,
      readyToDownload,
      replaceDownload: task.replaceDownload || refresh || undefined,
      error: undefined
    })
    this.start(task, connection)
  }

  resume(providers: ImageCanvasProvider[]): void {
    for (const task of this.entries) {
      if (this.active.size >= maxActive) break
      if (!['queued', 'running', 'downloading'].includes(task.status) || this.active.has(task.id)) continue
      const provider = providers.find((item) => item.id === task.providerId)
      try {
        if (!provider) throw new Error('provider_unavailable')
        this.recover(provider, task.id)
      } catch {
        this.update(task, { status: 'uncertain', error: 'provider_configuration_changed' })
      }
    }
  }

  private start(task: StoredTask, connection: ProviderConnection, body?: VideoSubmission): void {
    this.active.add(task.id)
    void this.run(task, connection, body)
      .catch((error) => {
        const code = error instanceof Error && /^video_http_\d{3}$/.test(error.message) ? error.message : undefined
        const rejected =
          !task.remoteId && code?.startsWith('video_http_4') && !['video_http_408', 'video_http_429'].includes(code)
        this.update(task, {
          status: rejected ? 'failed' : 'uncertain',
          recoverable: !!task.remoteId,
          error: code || (task.remoteId ? 'video_result_pending' : 'submit_uncertain')
        })
      })
      .catch(() => logger.error('Video task save failed', { taskId: task.id }))
      .finally(() => this.active.delete(task.id))
  }

  private async query(connection: ProviderConnection, path: string, body?: FormData | string): Promise<VideoResult> {
    const headers = new Headers(connection.headers)
    if (body instanceof FormData) headers.delete('content-type')
    const response = await this.request(`${connection.base}/videos${path}`, {
      method: body ? 'POST' : 'GET',
      body,
      headers,
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(35_000)
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`video_http_${response.status}`)
    }
    const result: VideoResponse = await response.json()
    return {
      id: result.id || result.data?.id,
      task_id: result.task_id || result.data?.task_id,
      status: result.status || result.data?.status
    }
  }

  private async run(task: StoredTask, connection: ProviderConnection, body?: VideoSubmission): Promise<void> {
    if (body) {
      const result = await this.query(connection, '', body.multipart).catch((error) => {
        // A 415 explicitly rejects the body encoding. A timeout or server error
        // doesn't establish that the original submission was rejected.
        if (!(error instanceof Error) || error.message !== 'video_http_415') throw error
        return this.query(connection, '', body.json())
      })
      const remoteId = result.id || result.task_id
      if (typeof remoteId !== 'string' || !taskIdPattern.test(remoteId)) throw new Error('invalid_video_task_id')
      this.update(task, { remoteId, status: 'queued', recoverable: true })
    }
    if (!task.remoteId || !taskIdPattern.test(task.remoteId)) throw new Error('invalid_video_task_id')
    const path = `/${encodeURIComponent(task.remoteId)}`
    let failures = 0
    const deadline = Date.now() + 30 * 60_000
    while (!task.readyToDownload && Date.now() < deadline) {
      let status: VideoResult
      try {
        status = await this.query(connection, path)
        failures = 0
      } catch (error) {
        if (++failures >= 4) throw error
        await new Promise((resolve) => setTimeout(resolve, failures * 5000))
        continue
      }
      switch (status.status?.toLowerCase()) {
        case 'completed':
        case 'succeeded':
        case 'success':
          this.update(task, { readyToDownload: true, status: 'downloading' })
          break
        case 'failed':
        case 'failure':
        case 'error':
        case 'cancelled':
        case 'canceled':
        case 'expired':
          this.update(task, { status: 'failed', error: 'video_generation_failed', recoverable: false })
          return
        case 'in_progress':
        case 'running':
        case 'processing':
          if (task.status !== 'running') this.update(task, { status: 'running' })
          break
      }
      if (!task.readyToDownload) await new Promise((resolve) => setTimeout(resolve, 5000))
    }
    if (!task.readyToDownload) throw new Error('video_result_pending')
    try {
      await this.download(task, connection, `${path}/content`)
      this.update(task, { status: 'completed', recoverable: false, replaceDownload: undefined, error: undefined })
    } finally {
      this.downloads.delete(task.id)
    }
  }

  private async download(task: StoredTask, connection: ProviderConnection, path: string): Promise<void> {
    const final = join(this.directory, `${task.id}.mp4`)
    if (!task.replaceDownload && existsSync(final)) return
    const scratch = `${final}.part`
    const signal = AbortSignal.timeout(5 * 60_000)
    const response = await this.request(`${connection.base}/videos${path}`, {
      headers: connection.headers,
      credentials: 'omit',
      redirect: 'error',
      signal
    })
    const lengthHeader = response.headers.get('content-length')
    const contentEncoding = response.headers.get('content-encoding')?.toLowerCase()
    // Fetch delivers decoded chunks, so a compressed Content-Length cannot be used as the progress total.
    const totalBytes =
      lengthHeader && /^\d+$/.test(lengthHeader) && (!contentEncoding || contentEncoding === 'identity')
        ? Number(lengthHeader)
        : 0
    if (!response.ok || !response.body || totalBytes > maxVideoBytes) {
      await response.body?.cancel()
      throw new Error(`video_http_${response.status}`)
    }
    const progress: VideoDownloadProgress = { receivedBytes: 0, totalBytes: totalBytes || undefined }
    this.downloads.set(task.id, progress)
    let header = Buffer.alloc(0)
    try {
      await pipeline(
        Readable.fromWeb(response.body as NodeReadableStream),
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            progress.receivedBytes += chunk.length
            if (header.length < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)])
            if (progress.receivedBytes > maxVideoBytes) done(new Error('video_too_large'))
            else done(null, chunk)
          }
        }),
        createWriteStream(scratch, { mode: 0o600 }),
        { signal }
      )
      if (header.length < 12 || header.toString('ascii', 4, 8) !== 'ftyp') throw new Error('invalid_video_result')
      await rename(scratch, final)
    } finally {
      await unlink(scratch).catch(() => undefined)
    }
  }

  file(id: string): string {
    if (this.task(id).status !== 'completed') throw new Error('video_task_unavailable')
    return join(this.directory, `${id}.mp4`)
  }

  async preview(id: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.file(id)))
  }

  async remove(id: string): Promise<void> {
    const task = this.task(id)
    if (this.active.has(id) || ['submitting', 'queued', 'running', 'downloading'].includes(task.status))
      throw new Error('task_running')
    const index = this.entries.indexOf(task)
    this.entries.splice(index, 1)
    try {
      this.persist()
    } catch (error) {
      this.entries.splice(index, 0, task)
      throw error
    }
    await unlink(join(this.directory, `${id}.mp4`)).catch(() => undefined)
  }
}
