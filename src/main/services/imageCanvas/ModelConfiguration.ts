import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ImageCanvasModelConfiguration, ImageCanvasProvider } from '@shared/config/imageCanvas'
import { configuredImageCapabilities, defaultImageCapabilities } from '@shared/config/imageCapabilities'

export class ImageModelConfiguration {
  private records: Record<string, ImageCanvasModelConfiguration> = {}
  private readonly file: string

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true })
    this.file = join(directory, 'models.json')
    if (existsSync(this.file)) {
      const data = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!data || data.version !== 1 || typeof data.models !== 'object' || Array.isArray(data.models))
        throw new Error('invalid_capabilities')
      for (const settings of Object.values(data.models))
        configuredImageCapabilities(settings as ImageCanvasModelConfiguration)
      this.records = data.models
    }
  }

  private key(provider: ImageCanvasProvider, modelId: string): string {
    return JSON.stringify([provider.id, provider.apiHost.replace(/\/+$/, ''), modelId])
  }

  apply(provider: ImageCanvasProvider): ImageCanvasProvider {
    return {
      ...provider,
      models: provider.models.map((model) => {
        const settings = this.records[this.key(provider, model.id)]
        return settings
          ? {
              ...model,
              protocol: settings.protocol,
              capabilities: configuredImageCapabilities(settings),
              configuration: structuredClone(settings)
            }
          : { ...model, capabilities: defaultImageCapabilities(model) }
      })
    }
  }

  configure(provider: ImageCanvasProvider, modelId: string, settings: ImageCanvasModelConfiguration | null): void {
    if (!provider.models.some((model) => model.id === modelId)) throw new Error('model_unavailable')
    if (settings !== null) configuredImageCapabilities(settings)
    const next = { ...this.records }
    const key = this.key(provider, modelId)
    if (settings === null) delete next[key]
    else next[key] = structuredClone(settings)
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, models: next }), { mode: 0o600 })
    renameSync(`${this.file}.tmp`, this.file)
    this.records = next
  }
}
