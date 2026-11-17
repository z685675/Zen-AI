import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import {
  BUILTIN_MODEL_CAPACITY_CATALOG,
  MODEL_CAPACITY_ENDPOINT,
  type ModelCapacityCatalog,
  setModelCapacityCatalog,
  validateModelCapacityCatalog
} from '@shared/modelCapacity'
import { app } from 'electron'

import { managedApiFetch } from './modelTransport/apiFetch'

const logger = loggerService.withContext('ModelCapacityService')
const REFRESH_INTERVAL_MS = 60 * 60_000
const MAX_CATALOG_BYTES = 4 * 1024 * 1024

/** Catalog updates never delay a model request or require a model-generation probe. */
export class ModelCapacityService {
  private current = BUILTIN_MODEL_CAPACITY_CATALOG
  private loading?: Promise<void>
  private pending?: Promise<void>
  private lastAttempt = -Infinity

  private get filepath() {
    return path.join(app.getPath('userData'), 'Data', 'ModelCapacity', 'catalog.json')
  }

  private load(): Promise<void> {
    return (this.loading ??= (async () => {
      try {
        const data = await fs.readFile(this.filepath, 'utf8')
        if (Buffer.byteLength(data) > MAX_CATALOG_BYTES) throw new Error('Cached model catalog is too large')
        const cached: unknown = JSON.parse(data)
        if (!validateModelCapacityCatalog(cached)) throw new Error('Invalid cached model capacity catalog')
        this.current = cached
        const fetchedAt = Date.parse(cached.updatedAt)
        if (fetchedAt <= Date.now()) this.lastAttempt = fetchedAt
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          logger.warn('Cannot load model capacity cache; using bundled catalog', error as Error)
      }
      setModelCapacityCatalog(this.current)
    })())
  }

  async getSnapshot(): Promise<ModelCapacityCatalog> {
    await this.load()
    void this.refresh()
    return this.current
  }

  async refresh(): Promise<void> {
    if (this.pending) return this.pending
    if (Date.now() - this.lastAttempt < REFRESH_INTERVAL_MS) return
    this.lastAttempt = Date.now()
    this.pending = (async () => {
      try {
        // This public metadata request contains no API key, user prompt or attachment.
        const response = await managedApiFetch(MODEL_CAPACITY_ENDPOINT, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000)
        })
        if (!response.ok) throw new Error(`Model capacity catalog HTTP ${response.status}`)
        if (Number(response.headers.get('content-length')) > MAX_CATALOG_BYTES)
          throw new Error('Model capacity catalog is too large')
        const text = await response.text()
        if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) throw new Error('Model capacity catalog is too large')
        const next: unknown = JSON.parse(text)
        if (!validateModelCapacityCatalog(next)) throw new Error('Invalid API model capacity catalog')
        this.current = next
        setModelCapacityCatalog(next)
        const filename = this.filepath
        const temporary = `${filename}.${process.pid}.tmp`
        await fs.mkdir(path.dirname(filename), { recursive: true })
        try {
          await fs.writeFile(temporary, JSON.stringify(next), 'utf8')
          await fs.rename(temporary, filename)
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => {})
        }
      } catch (error) {
        logger.warn('Cannot refresh model capacities; keeping the last usable catalog', error as Error)
      }
    })().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }
}

export const modelCapacityService = new ModelCapacityService()
