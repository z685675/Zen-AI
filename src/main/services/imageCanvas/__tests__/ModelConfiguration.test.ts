import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ImageCanvasProvider } from '@shared/config/imageCanvas'
import { describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')

import { ImageModelConfiguration } from '../ModelConfiguration'

describe('local image compatibility configuration', () => {
  it('scopes aliases to a provider endpoint, persists no keys, and restores defaults', () => {
    const path = mkdtempSync(join(tmpdir(), 'image-model-config-'))
    try {
      const provider: ImageCanvasProvider = {
        id: 'p',
        name: 'Provider',
        apiHost: 'https://example.test/v1',
        apiKey: 'private-secret',
        models: [{ id: 'alias', name: 'Alias', protocol: 'openai' }]
      }
      const settings = {
        protocol: 'openai' as const,
        sizes: ['2560x1440'],
        ratios: [],
        resolutions: [],
        qualities: ['high'],
        backgrounds: [],
        minReferences: 0,
        maxReferences: 3,
        maxImages: 1
      }
      const configuration = new ImageModelConfiguration(path)
      configuration.configure(provider, 'alias', settings)
      const restored = new ImageModelConfiguration(path)
      expect(restored.apply(provider).models[0].capabilities).toMatchObject({
        source: 'custom',
        maxReferences: 3,
        dimensions: [{ ratio: '16:9', size: '2560x1440' }]
      })
      expect(restored.apply({ ...provider, id: 'other' }).models[0].capabilities?.source).toBe('builtin')
      expect(restored.apply({ ...provider, apiHost: provider.apiHost + '#' }).models[0].capabilities?.source).toBe(
        'builtin'
      )
      expect(restored.apply({ ...provider, apiHost: 'https://other.test/v1' }).models[0].capabilities?.source).toBe(
        'builtin'
      )
      expect(readFileSync(join(path, 'models.json'), 'utf8')).not.toContain('private-secret')
      restored.configure(provider, 'alias', null)
      expect(restored.apply(provider).models[0].capabilities?.source).toBe('builtin')
    } finally {
      rmSync(path, { recursive: true, force: true })
    }
  })
})
