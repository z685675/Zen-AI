import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loggerService } from '@logger'
import type {
  ImageCanvasHistoryPage,
  ImageCanvasProgress,
  ImageCanvasProvider,
  ImageCanvasRequest,
  ImageCanvasTask
} from '@shared/config/imageCanvas'
import { defaultImageCapabilities } from '@shared/config/imageCapabilities'
import sharp from 'sharp'

import { readExternalImages } from './externalImages'
import {
  decodeImage,
  generateCanvasImages,
  type ImageFetch,
  validateCanvasModel,
  validateCanvasRequest
} from './protocol'
import { type CanvasRemoteJob, readStudioImages } from './studio'

type StoredTask = ImageCanvasTask & { fingerprint: string; remote?: CanvasRemoteJob; providerBinding?: string }
const logger = loggerService.withContext('ImageCanvas')

function providerBinding(provider: ImageCanvasProvider): string {
  const key = provider.apiKey
    .split(/(?<!\\),|\r?\n/)
    .map((value) => value.trim().replace(/\\,/g, ','))
    .find(Boolean)
  return createHash('sha256')
    .update(
      JSON.stringify([
        provider.apiHost.replace(/\/+$/, ''),
        key,
        Object.entries(provider.headers || {}).sort(([a], [b]) => a.localeCompare(b))
      ])
    )
    .digest('hex')
}

// Separate storage: this integration does not change Zen-AI's Redux or Dexie schema.
export class ImageCanvasTaskStore {
  private tasks: StoredTask[] = []
  private active = 0
  private pending: Array<() => void> = []
  private activePhases = new Map<string, { phase: NonNullable<ImageCanvasTask['phase']>; started: number }>()
  private readonly index: string

  constructor(
    private readonly directory: string,
    private readonly request: ImageFetch
  ) {
    mkdirSync(directory, { recursive: true })
    this.index = join(directory, 'tasks.json')
    if (existsSync(this.index)) {
      // A corrupt index must not silently discard billing/deduplication evidence.
      const records: StoredTask[] = JSON.parse(readFileSync(this.index, 'utf8'))
      if (!Array.isArray(records)) throw new Error('invalid_task_index')
      const validId = (id: unknown) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)
      if (
        records.some(
          (task) =>
            !task ||
            !validId(task.id) ||
            !Array.isArray(task.assets) ||
            task.assets.some((id) => !validId(id)) ||
            (task.referenceAssets !== undefined &&
              (!Array.isArray(task.referenceAssets) || task.referenceAssets.some((id) => !validId(id)))) ||
            (task.maskAsset !== undefined && !validId(task.maskAsset)) ||
            (task.batchId !== undefined && !validId(task.batchId))
        )
      )
        throw new Error('invalid_task_index')
      this.tasks = records.map((task) => {
        if (task.status !== 'running') return task
        return {
          ...task,
          status: 'uncertain',
          error: 'interrupted_check_provider',
          diagnostics: task.diagnostics ? { ...task.diagnostics, failedPhase: task.phase } : undefined,
          phase: undefined
        }
      })
      this.persist()
    }
  }

  history(): ImageCanvasTask[] {
    return this.tasks.slice(0, 100).map((task) => this.publicTask(task))
  }

  historyPage(cursor?: string, limit = 30): ImageCanvasHistoryPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_history_page')
    let before: { createdAt: string; id: string } | undefined
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 200) throw new Error()
        before = JSON.parse(Buffer.from(cursor, 'base64url').toString())
        if (
          !before ||
          typeof before.createdAt !== 'string' ||
          !/^\d{4}-\d\d-\d\dT/.test(before.createdAt) ||
          !/^[a-f0-9-]{36}$/.test(before.id)
        )
          throw new Error()
      } catch {
        throw new Error('invalid_history_page')
      }
    }
    const ordered = this.tasks
      .filter(
        (task) =>
          !before || task.createdAt < before.createdAt || (task.createdAt === before.createdAt && task.id < before.id)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const page = ordered.slice(0, limit)
    const last = page.at(-1)
    return {
      items: page.map((task) => this.publicTask(task)),
      total: this.tasks.length,
      ...(ordered.length > limit && last
        ? { nextCursor: Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64url') }
        : {})
    }
  }

  task(id: string): ImageCanvasTask | undefined {
    const task = this.tasks.find((item) => item.id === id)
    return task ? this.publicTask(task) : undefined
  }

  private publicTask(task: StoredTask): ImageCanvasTask {
    const diagnostics = task.diagnostics ? structuredClone(task.diagnostics) : undefined
    const active = this.activePhases.get(task.id)
    if (diagnostics && active && task.status === 'running') {
      const timings = diagnostics.phaseDurationsMs
      timings[active.phase] = (timings[active.phase] || 0) + Math.max(0, Math.round(performance.now() - active.started))
    }
    return {
      id: task.id,
      providerId: task.providerId,
      modelId: task.modelId,
      prompt: task.prompt,
      createdAt: task.createdAt,
      status: task.status,
      assets: [...task.assets],
      outputSizes: task.outputSizes ? [...task.outputSizes] : undefined,
      error: task.error,
      recoverable: !!task.remote && task.error !== 'studio_server_image_resolution_unavailable',
      phase: task.phase,
      diagnostics,
      providerName: task.providerName,
      modelName: task.modelName,
      parameters: task.parameters ? structuredClone(task.parameters) : undefined,
      referenceAssets: task.referenceAssets ? [...task.referenceAssets] : undefined,
      maskAsset: task.maskAsset,
      batchId: task.batchId
    }
  }

  async asset(id: string): Promise<string> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('asset_unavailable')
    if (this.tasks.some((task) => task.assets.includes(id)))
      return `data:image/png;base64,${readFileSync(join(this.directory, `${id}.png`)).toString('base64')}`
    if (!this.tasks.some((task) => task.referenceAssets?.includes(id) || task.maskAsset === id))
      throw new Error('asset_unavailable')
    const bytes = readFileSync(join(this.directory, `${id}.reference`))
    const mime = bytes[0] === 137 ? 'image/png' : bytes[0] === 255 ? 'image/jpeg' : 'image/webp'
    return `data:${mime};base64,${bytes.toString('base64')}`
  }

  submitBatch(providers: ImageCanvasProvider[], inputs: ImageCanvasRequest[]): ImageCanvasTask[] {
    if (
      inputs.length < 2 ||
      inputs.length > 4 ||
      providers.length !== inputs.length ||
      this.active + this.pending.length + inputs.length > 8
    )
      throw new Error('too_many_tasks')
    if (
      !inputs[0].batchId ||
      inputs.some((input) => input.batchId !== inputs[0].batchId) ||
      new Set(inputs.map((input) => input.id)).size !== inputs.length ||
      new Set(inputs.map((input) => JSON.stringify([input.providerId, input.modelId]))).size !== inputs.length
    )
      throw new Error('invalid_request')
    inputs.forEach((input, index) => {
      validateCanvasRequest(input)
      validateCanvasModel(providers[index], input)
      const existing = this.tasks.find((task) => task.id === input.id)
      if (existing && existing.fingerprint !== createHash('sha256').update(JSON.stringify(input)).digest('hex'))
        throw new Error('request_id_conflict')
    })
    return inputs.map((input, index) => this.submit(providers[index], input, true))
  }

  submit(provider: ImageCanvasProvider, input: ImageCanvasRequest, queued = false): ImageCanvasTask {
    validateCanvasRequest(input)
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const existing = this.tasks.find((task) => task.id === input.id)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('request_id_conflict')
      return this.task(input.id)!
    }
    validateCanvasModel(provider, input)
    if (this.active >= 2 && !queued) throw new Error('too_many_tasks')
    const { references } = input
    const parameters = {
      size: input.size,
      resolution: input.resolution,
      aspectRatio: input.aspectRatio,
      quality: input.quality,
      background: input.background,
      count: input.count,
      expansion: input.expansion ? { ...input.expansion } : undefined
    }
    const referenceAssets: string[] = []
    let maskAsset: string | undefined
    try {
      for (const reference of references) {
        const id = randomUUID()
        const path = join(this.directory, `${id}.reference`)
        writeFileSync(`${path}.tmp`, decodeImage(reference).bytes, { mode: 0o600 })
        renameSync(`${path}.tmp`, path)
        referenceAssets.push(id)
      }
      if (input.mask) {
        maskAsset = randomUUID()
        const path = join(this.directory, `${maskAsset}.reference`)
        writeFileSync(`${path}.tmp`, decodeImage(input.mask).bytes, { mode: 0o600 })
        renameSync(`${path}.tmp`, path)
      }
    } catch (error) {
      for (const id of referenceAssets) unlinkSync(join(this.directory, `${id}.reference`))
      if (maskAsset && existsSync(join(this.directory, `${maskAsset}.reference`)))
        unlinkSync(join(this.directory, `${maskAsset}.reference`))
      throw error
    }
    const model = provider.models.find((model) => model.id === input.modelId)!
    const capabilities = model.capabilities || defaultImageCapabilities(model)
    const task: StoredTask = {
      id: input.id,
      providerId: input.providerId,
      modelId: input.modelId,
      prompt: input.prompt,
      createdAt: new Date().toISOString(),
      status: 'running',
      assets: [],
      fingerprint,
      providerBinding: providerBinding(provider),
      providerName: provider.name,
      modelName: provider.models.find((model) => model.id === input.modelId)?.name,
      parameters,
      referenceAssets,
      maskAsset,
      batchId: input.batchId,
      phase: 'preparing',
      diagnostics: {
        protocol: model.protocol,
        capabilityRevision:
          capabilities.revision ||
          createHash('sha256')
            .update(JSON.stringify([model.protocol, capabilities]))
            .digest('hex')
            .slice(0, 16),
        capabilitySource: capabilities.source,
        attempts: 0,
        phaseDurationsMs: {}
      }
    }
    this.tasks.unshift(task)
    try {
      this.persist()
    } catch (error) {
      this.tasks.shift()
      for (const id of referenceAssets) unlinkSync(join(this.directory, `${id}.reference`))
      if (maskAsset) unlinkSync(join(this.directory, `${maskAsset}.reference`))
      throw error
    }
    const start = () => {
      this.active++
      void this.run(structuredClone(provider), structuredClone(input), task)
    }
    if (this.active < 2) start()
    else {
      task.phase = 'queued'
      this.pending.push(start)
      this.persist()
    }
    return this.task(task.id)!
  }

  recover(provider: ImageCanvasProvider, id: string): ImageCanvasTask {
    const task = this.tasks.find((task) => task.id === id && task.providerId === provider.id)
    if (!task?.remote) throw new Error('studio_job_unavailable')
    if (task.providerBinding && task.providerBinding !== providerBinding(provider))
      throw new Error('provider_configuration_changed')
    if (task.status === 'running' || task.status === 'completed') return this.publicTask(task)
    if (this.active >= 2) throw new Error('too_many_tasks')
    const previous = { status: task.status, error: task.error }
    task.status = 'running'
    task.error = undefined
    try {
      this.persist()
    } catch (error) {
      Object.assign(task, previous)
      throw error
    }
    this.active++
    void this.run(structuredClone(provider), undefined, task)
    return this.publicTask(task)
  }

  remove(id: string): void {
    const task = this.tasks.find((item) => item.id === id)
    if (!task) throw new Error('task_unavailable')
    if (task.status === 'running') throw new Error('task_running')
    const previous = this.tasks
    this.tasks = this.tasks.filter((item) => item !== task)
    try {
      this.persist()
    } catch (error) {
      this.tasks = previous
      throw error
    }
    for (const [ids, extension] of [
      [task.assets, 'png'],
      [[...(task.referenceAssets || []), ...(task.maskAsset ? [task.maskAsset] : [])], 'reference']
    ] as const) {
      for (const asset of ids) {
        if (
          this.tasks.some(
            (item) => item.assets.includes(asset) || item.referenceAssets?.includes(asset) || item.maskAsset === asset
          )
        )
          continue
        const file = join(this.directory, `${asset}.${extension}`)
        try {
          if (existsSync(file)) unlinkSync(file)
        } catch {
          /* An orphan can be removed later; the index is already durable. */
        }
      }
    }
  }

  private async run(
    provider: ImageCanvasProvider,
    input: ImageCanvasRequest | undefined,
    task: StoredTask
  ): Promise<void> {
    let phase = task.phase || 'preparing'
    let phaseStart = performance.now()
    this.activePhases.set(task.id, { phase, started: phaseStart })
    if (task.diagnostics) {
      task.diagnostics.attempts++
      task.diagnostics.finishedAt = undefined
      task.diagnostics.failedPhase = undefined
    }
    const finishPhase = () => {
      if (task.diagnostics) {
        const timings = task.diagnostics.phaseDurationsMs
        timings[phase] = (timings[phase] || 0) + Math.max(0, Math.round(performance.now() - phaseStart))
      }
      phaseStart = performance.now()
    }
    const progress: ImageCanvasProgress = (next, capability, server) => {
      if (capability && task.diagnostics) Object.assign(task.diagnostics, capability)
      const changed = server && task.diagnostics && JSON.stringify(server) !== JSON.stringify(task.diagnostics.server)
      if (changed) task.diagnostics!.server = structuredClone(server)
      if (task.phase === next && !capability && !changed) return
      finishPhase()
      phase = next
      this.activePhases.set(task.id, { phase, started: phaseStart })
      task.phase = next
      this.persist()
    }
    try {
      try {
        for (const reference of input?.references || [])
          await sharp(decodeImage(reference).bytes, { limitInputPixels: 100_000_000 }).metadata()
      } catch {
        throw new Error('invalid_image')
      }
      progress(input ? 'preparing' : 'queued')
      const images = input
        ? await generateCanvasImages(
            provider,
            input,
            this.request,
            (remote) => {
              task.remote = remote
              this.persist()
            },
            progress
          )
        : task.remote?.kind
          ? await readExternalImages(provider, task.remote, this.request, progress)
          : await readStudioImages(provider, task.remote!, this.request, undefined, progress)
      for (const [index, bytes] of images.entries()) {
        if (task.assets[index]) continue
        progress('decoding')
        let normalized: Buffer
        try {
          normalized = await sharp(bytes, { limitInputPixels: 100_000_000 }).rotate().png().toBuffer()
        } catch {
          throw new Error('invalid_result_image')
        }
        if (normalized.length > 40 * 1024 * 1024) throw new Error('result_too_large')
        progress('saving')
        const id = randomUUID()
        const path = join(this.directory, `${id}.png`)
        try {
          writeFileSync(`${path}.tmp`, normalized)
          renameSync(`${path}.tmp`, path)
        } catch {
          throw new Error('image_storage_failed')
        }
        task.assets.push(id)
        const metadata = await sharp(normalized).metadata()
        if (metadata.width && metadata.height) (task.outputSizes ??= []).push(`${metadata.width}x${metadata.height}`)
        this.persist()
      }
      if (images.length < (task.parameters?.count || 1)) {
        task.status = 'uncertain'
        task.error = 'partial_image_result'
      } else {
        task.status = 'completed'
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      task.status =
        /^(?:upstream_http_4(?!08|09|29)\d\d|studio_upgrade_required|studio_model_unavailable|studio_reference_limit|studio_parameters_unsupported|studio_generation_failed|studio_http_40[013]|gemini_size_unsupported|image_dimensions_unsupported|invalid_image)$/.test(
          code
        ) ||
        /^(?:studio_server_(?:generation_failed|storage_unavailable|image_resolution_unavailable|cancelled)|invalid_mask|invalid_expansion|invalid_workflow|invalid_request|image_reference_or_count_unsupported|references_too_large|dashscope_model_unsupported|external_job_failed)$/.test(
          code
        )
          ? 'failed'
          : 'uncertain'
      // Only stable codes cross the bridge; never include request headers or response bodies.
      task.error =
        /^(upstream_http_\d{3}|studio_(?:server_[a-z_]+|http_\d{3}|upgrade_required|model_unavailable|reference_limit|parameters_unsupported|generation_failed|result_pending|download_failed|job_unavailable|invalid_result)|gemini_size_unsupported|no_image_result|invalid_result_image|invalid_result_url|result_too_large|provider_key_missing|background_unsupported|invalid_image|image_dimensions_unsupported|image_reference_or_count_unsupported|references_too_large|invalid_request|image_storage_failed|invalid_mask|invalid_expansion|invalid_workflow|dashscope_model_unsupported|external_job_(?:failed|pending|invalid))$/.test(
          code
        )
          ? code
          : 'request_uncertain_check_provider'
      if (task.diagnostics) task.diagnostics.failedPhase = phase
      logger.error('Image task stopped', { taskId: task.id, phase, code: task.error, recoverable: !!task.remote })
    } finally {
      finishPhase()
      this.activePhases.delete(task.id)
      if (task.diagnostics) {
        task.diagnostics.finishedAt = new Date().toISOString()
        if (task.error && !task.diagnostics.failedPhase) task.diagnostics.failedPhase = phase
      }
      task.phase = undefined
      this.active--
      this.pending.shift()?.()
      // Keep the running record on disk if the final write fails; restart treats it as uncertain.
      try {
        this.persist()
      } catch {
        logger.error('Image task index save failed', { taskId: task.id, code: 'task_index_write_failed' })
      }
    }
  }

  private persist(): void {
    writeFileSync(`${this.index}.tmp`, JSON.stringify(this.tasks), { mode: 0o600 })
    renameSync(`${this.index}.tmp`, this.index)
  }
}
