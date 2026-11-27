import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loggerService } from '@logger'
import type {
  ImageCanvasHistoryPage,
  ImageCanvasProgress,
  ImageCanvasProvider,
  ImageCanvasRequest,
  ImageCanvasTask,
  LegacyImageRecord
} from '@shared/config/imageCanvas'
import { imageCanvasMaxBatchTasks } from '@shared/config/imageCanvas'
import { defaultImageCapabilities } from '@shared/config/imageCapabilities'
import { groupImageCanvasTasks } from '@shared/config/imageRecords'
import { isZenManagedApiHost } from '@shared/config/zenProvider'
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
import { StudioAssetCache } from './StudioAssetCache'
import { ImageStudioRequestError } from './studioRequest'

type StoredTask = ImageCanvasTask & { fingerprint: string; remote?: CanvasRemoteJob; providerBinding?: string }
const logger = loggerService.withContext('ImageCanvas')

function legacyId(parts: Array<string | number>): string {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

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
  private readonly legacyIndex: string
  private legacyImports?: Set<string>
  private readonly studioAssets: StudioAssetCache

  constructor(
    private readonly directory: string,
    private readonly request: ImageFetch
  ) {
    mkdirSync(directory, { recursive: true })
    this.studioAssets = new StudioAssetCache(directory)
    this.index = join(directory, 'tasks.json')
    this.legacyIndex = join(directory, 'legacy-imports.json')
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
        const notSubmitted =
          !task.remote && (task.phase === 'queued' || task.diagnostics?.generationSubmitted === false)
        return {
          ...task,
          status: notSubmitted ? 'failed' : 'uncertain',
          error: notSubmitted ? 'studio_preparation_interrupted' : 'interrupted_check_provider',
          diagnostics: task.diagnostics ? { ...task.diagnostics, failedPhase: task.phase } : undefined,
          phase: undefined
        }
      })
      this.persist()
    }
  }

  history(): ImageCanvasTask[] {
    return this.historyPage(undefined, 100).items
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
    const records = groupImageCanvasTasks(this.tasks)
    const ordered = records.filter(
      ({ latest }) =>
        !before ||
        latest.createdAt < before.createdAt ||
        (latest.createdAt === before.createdAt && latest.id < before.id)
    )
    const page = ordered.slice(0, limit)
    const last = page.at(-1)?.latest
    return {
      items: page.flatMap((record) => record.tasks.map((task) => this.publicTask(task))),
      total: records.length,
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
      ...(task.importedLegacy ? { importedLegacy: true } : {}),
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

  private importedIds(): Set<string> {
    this.legacyImports ??= new Set<string>(
      existsSync(this.legacyIndex) ? JSON.parse(readFileSync(this.legacyIndex, 'utf8')) : []
    )
    return this.legacyImports
  }

  private markImported(id: string): void {
    const ids = this.importedIds()
    if (ids.has(id)) return
    writeFileSync(`${this.legacyIndex}.tmp`, JSON.stringify([...ids, id]), { mode: 0o600 })
    renameSync(`${this.legacyIndex}.tmp`, this.legacyIndex)
    ids.add(id)
  }

  async importLegacy(
    record: LegacyImageRecord,
    readAsset: (source: LegacyImageRecord['assets'][number]) => Promise<Buffer>
  ): Promise<number> {
    const id = legacyId(['record', record.id])
    if (this.importedIds().has(id)) return 0
    const existing = this.tasks.find((task) => task.id === id)
    const assets: string[] = []
    let missing = 0
    for (const [index, source] of record.assets.entries()) {
      const assetId = legacyId(['asset', record.id, index])
      const file = join(this.directory, `${assetId}.png`)
      try {
        if (!existsSync(file)) {
          const png = await sharp(await readAsset(source), { limitInputPixels: 50_000_000 })
            .rotate()
            .png()
            .toBuffer()
          writeFileSync(`${file}.tmp`, png, { mode: 0o600 })
          renameSync(`${file}.tmp`, file)
        }
        assets.push(assetId)
      } catch {
        missing++
      }
    }
    if (this.importedIds().has(id)) {
      for (const asset of assets) {
        const file = join(this.directory, `${asset}.png`)
        if (existsSync(file)) unlinkSync(file)
      }
      return 0
    }
    if (!existing || JSON.stringify(existing.assets) !== JSON.stringify(assets)) {
      const previous = this.tasks
      this.tasks = [
        {
          id,
          fingerprint: id,
          importedLegacy: true,
          providerId: '',
          modelId: '',
          prompt: record.prompt,
          createdAt: new Date(Date.parse(record.createdAt || '') || 0).toISOString(),
          status: assets.length ? 'completed' : 'failed',
          error: assets.length ? undefined : 'legacy_image_unavailable',
          assets
        },
        ...previous.filter((task) => task.id !== id)
      ]
      try {
        this.persist()
      } catch (error) {
        this.tasks = previous
        throw error
      }
    }
    if (!missing) this.markImported(id)
    return missing
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
      inputs.length > imageCanvasMaxBatchTasks ||
      providers.length !== inputs.length ||
      this.active + this.pending.length + inputs.length > imageCanvasMaxBatchTasks
    )
      throw new Error('too_many_tasks')
    if (
      !inputs[0].batchId ||
      inputs.some((input) => input.batchId !== inputs[0].batchId) ||
      new Set(inputs.map((input) => input.id)).size !== inputs.length
    )
      throw new Error('invalid_request')
    const modelTasks = new Map<string, ImageCanvasRequest[]>()
    for (const input of inputs) {
      const key = JSON.stringify([input.providerId, input.modelId])
      const tasks = modelTasks.get(key) ?? []
      tasks.push(input)
      modelTasks.set(key, tasks)
    }
    if (
      modelTasks.size > 4 ||
      [...modelTasks.values()].some(
        (tasks) => tasks.length > 4 || (tasks.length > 1 && tasks.some((input) => input.count !== 1))
      )
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
        phaseDurationsMs: {},
        transport: isZenManagedApiHost(provider.apiHost) ? 'studio' : 'direct',
        generationSubmitted: false
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

  recover(provider: ImageCanvasProvider, id: string, assetId?: string): ImageCanvasTask {
    const task = this.tasks.find((task) => task.id === id && task.providerId === provider.id)
    if (!task?.remote) throw new Error('studio_job_unavailable')
    if (task.providerBinding && task.providerBinding !== providerBinding(provider))
      throw new Error('provider_configuration_changed')
    const repairIndex = assetId === undefined ? undefined : task.assets.indexOf(assetId)
    if (repairIndex === -1) throw new Error('asset_unavailable')
    if (task.status === 'running' || (task.status === 'completed' && repairIndex === undefined))
      return this.publicTask(task)
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
    void this.run(structuredClone(provider), undefined, task, repairIndex)
    return this.publicTask(task)
  }

  remove(id: string): void {
    const task = this.tasks.find((item) => item.id === id)
    if (!task) throw new Error('task_unavailable')
    if (task.status === 'running') throw new Error('task_running')
    if (task.importedLegacy) this.markImported(id)
    const previous = this.tasks
    this.tasks = this.tasks.filter((item) => item !== task)
    try {
      this.persist()
    } catch (error) {
      this.tasks = previous
      throw error
    }
    if (task.providerBinding && /^[a-f0-9]{64}$/.test(task.providerBinding)) {
      const downloads = this.studioAssets.forScope(task.providerBinding).downloads
      for (const download of task.diagnostics?.downloads || [])
        if (/^[a-f0-9-]{32,64}$/.test(download.assetId)) downloads?.remove(download.assetId)
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
    task: StoredTask,
    repairIndex?: number
  ): Promise<void> {
    let phase = task.phase || 'preparing'
    let phaseStart = performance.now()
    const previousDownloads = new Map(
      task.diagnostics?.downloads?.map((download) => [download.assetId, download.history])
    )
    this.activePhases.set(task.id, { phase, started: phaseStart })
    if (task.diagnostics) {
      task.diagnostics.attempts++
      task.diagnostics.finishedAt = undefined
      task.diagnostics.failedPhase = undefined
      task.diagnostics.requestFailure = undefined
    }
    const finishPhase = () => {
      if (task.diagnostics) {
        const timings = task.diagnostics.phaseDurationsMs
        timings[phase] = (timings[phase] || 0) + Math.max(0, Math.round(performance.now() - phaseStart))
      }
      phaseStart = performance.now()
    }
    const progress: ImageCanvasProgress = (next, capability, server, download) => {
      if (next === 'generating' && task.diagnostics?.transport === 'direct') {
        task.diagnostics.generationSubmitted = true
      }
      if (download && task.diagnostics) {
        const downloads = (task.diagnostics.downloads ??= [])
        const index = downloads.findIndex((entry) => entry.assetId === download.assetId)
        const snapshot = structuredClone(download)
        snapshot.history = [
          ...(previousDownloads.get(download.assetId) || []),
          ...snapshot.history.map((attempt) => ({ ...attempt, run: task.diagnostics!.attempts }))
        ].slice(-12)
        if (index < 0) downloads.push(snapshot)
        else downloads[index] = snapshot
      }
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
      const studioAssets = isZenManagedApiHost(provider.apiHost)
        ? this.studioAssets.forScope(providerBinding(provider))
        : undefined
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
              if (task.diagnostics?.transport === 'studio') task.diagnostics.generationSubmitted = true
              this.persist()
            },
            progress,
            studioAssets
          )
        : task.remote?.kind
          ? await readExternalImages(provider, task.remote, this.request, progress)
          : await readStudioImages(provider, task.remote!, this.request, undefined, progress, studioAssets)
      for (const [index, bytes] of images.entries()) {
        const currentAsset = task.assets[index]
        if (currentAsset && index !== repairIndex) continue
        progress('decoding')
        let normalized: Buffer
        try {
          normalized = await sharp(bytes, { limitInputPixels: 100_000_000 }).rotate().png().toBuffer()
          // Avoid aliasing an EXIF rotation: the remote original may be interpreted
          // differently by a provider. Ordinary generated PNGs keep the same pixels.
          if (studioAssets && ((await sharp(bytes).metadata()).orientation ?? 1) === 1)
            studioAssets.alias(bytes, normalized)
        } catch {
          throw new Error('invalid_result_image')
        }
        if (normalized.length > 40 * 1024 * 1024) throw new Error('result_too_large')
        progress('saving')
        const id = currentAsset || randomUUID()
        const path = join(this.directory, `${id}.png`)
        try {
          writeFileSync(`${path}.tmp`, normalized)
          renameSync(`${path}.tmp`, path)
        } catch {
          throw new Error('image_storage_failed')
        }
        if (!currentAsset) {
          task.assets.push(id)
          const metadata = await sharp(normalized).metadata()
          if (metadata.width && metadata.height) (task.outputSizes ??= []).push(`${metadata.width}x${metadata.height}`)
        }
        this.persist()
      }
      if (
        images.length < (task.parameters?.count || 1) ||
        (repairIndex !== undefined && repairIndex >= images.length)
      ) {
        task.status = 'uncertain'
        task.error = 'partial_image_result'
      } else {
        task.status = 'completed'
        for (const download of task.diagnostics?.downloads || []) studioAssets?.downloads?.remove(download.assetId)
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const notSubmitted = task.diagnostics?.generationSubmitted === false && !task.remote
      if (error instanceof ImageStudioRequestError && task.diagnostics)
        task.diagnostics.requestFailure = { ...error.failure }
      task.status =
        notSubmitted ||
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
          : notSubmitted
            ? phase === 'configuring'
              ? 'studio_bootstrap_failed'
              : phase === 'uploading'
                ? 'studio_reference_upload_failed'
                : 'studio_preparation_failed'
            : 'request_uncertain_check_provider'
      if (task.diagnostics) task.diagnostics.failedPhase = phase
      logger.error('Image task stopped', {
        taskId: task.id,
        phase,
        code: task.error,
        recoverable: !!task.remote,
        generationSubmitted: task.diagnostics?.generationSubmitted,
        requestFailure: task.diagnostics?.requestFailure
      })
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
