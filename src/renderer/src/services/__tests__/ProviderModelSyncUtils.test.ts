import type { Model, Provider } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import {
  getProviderModelSyncFingerprint,
  markProviderModelSyncFailed,
  mergeSyncedProviderModels
} from '../ProviderModelSyncUtils'

const createProvider = (overrides: Partial<Provider> = {}): Provider => ({
  id: 'provider-1',
  type: 'new-api',
  name: 'Provider 1',
  apiKey: 'key',
  apiHost: 'https://example.com/v1',
  models: [],
  enabled: true,
  ...overrides
})

const createModel = (id: string, overrides: Partial<Model> = {}): Model => ({
  id,
  provider: 'provider-1',
  name: id,
  group: 'default',
  ...overrides
})

describe('ProviderModelSyncUtils', () => {
  describe('mergeSyncedProviderModels', () => {
    it('adds fetched models and removes only previously synced missing models', () => {
      const provider = createProvider({
        models: [
          createModel('manual-model'),
          createModel('remote-a', { name: 'Old Remote A' }),
          createModel('remote-b'),
          createModel('protected-model')
        ],
        modelSync: {
          remoteModelIds: ['remote-a', 'remote-b', 'protected-model'],
          syncedAt: 100
        }
      })

      const nextProvider = mergeSyncedProviderModels(
        provider,
        [
          createModel('remote-a', {
            name: 'New Remote A',
            supported_endpoint_types: ['openai-response']
          }),
          createModel('remote-c')
        ],
        {
          preserveModelIds: ['protected-model'],
          sourceFingerprint: 'fingerprint-1',
          syncedAt: 200
        }
      )

      expect(nextProvider.models.map((model) => model.id)).toEqual([
        'manual-model',
        'remote-a',
        'protected-model',
        'remote-c'
      ])
      expect(nextProvider.models.find((model) => model.id === 'remote-a')?.name).toBe('New Remote A')
      expect(nextProvider.models.find((model) => model.id === 'remote-a')?.endpoint_type).toBe('openai-response')
      expect(nextProvider.modelSync).toEqual({
        remoteModelIds: ['remote-a', 'remote-c'],
        syncedAt: 200,
        sourceFingerprint: 'fingerprint-1',
        lastAttemptAt: 200,
        lastSuccessAt: 200,
        lastFailureAt: undefined
      })
    })

    it('does not remove existing models when the fetched list is empty', () => {
      const provider = createProvider({
        models: [createModel('manual-model'), createModel('remote-a')],
        modelSync: {
          remoteModelIds: ['remote-a'],
          syncedAt: 100
        }
      })

      const nextProvider = mergeSyncedProviderModels(provider, [], { syncedAt: 200 })

      expect(nextProvider).toBe(provider)
    })

    it('does not remove existing models on the first successful sync without prior metadata', () => {
      const provider = createProvider({
        models: [createModel('existing-model')]
      })

      const nextProvider = mergeSyncedProviderModels(provider, [createModel('remote-a')], { syncedAt: 200 })

      expect(nextProvider.models.map((model) => model.id)).toEqual(['existing-model', 'remote-a'])
      expect(nextProvider.modelSync?.remoteModelIds).toEqual(['remote-a'])
    })

    it('preserves manually configured endpoint type when synced model has no endpoint metadata', () => {
      const provider = createProvider({
        models: [
          createModel('image-model', {
            endpoint_type: 'image-generation'
          })
        ],
        modelSync: {
          remoteModelIds: ['image-model'],
          syncedAt: 100
        }
      })

      const nextProvider = mergeSyncedProviderModels(provider, [createModel('image-model')], { syncedAt: 200 })

      const syncedModel = nextProvider.models.find((model) => model.id === 'image-model')
      expect(syncedModel?.endpoint_type).toBe('image-generation')
    })

    it('uses remote endpoint metadata when the provider returns supported endpoint types', () => {
      const provider = createProvider({
        models: [
          createModel('remote-a', {
            endpoint_type: 'image-generation'
          })
        ],
        modelSync: {
          remoteModelIds: ['remote-a'],
          syncedAt: 100
        }
      })

      const nextProvider = mergeSyncedProviderModels(
        provider,
        [
          createModel('remote-a', {
            supported_endpoint_types: ['openai-response']
          })
        ],
        { syncedAt: 200 }
      )

      const syncedModel = nextProvider.models.find((model) => model.id === 'remote-a')
      expect(syncedModel?.endpoint_type).toBe('openai-response')
    })
  })

  describe('getProviderModelSyncFingerprint', () => {
    it('ignores provider display name changes', () => {
      const provider = createProvider({ name: 'Old Name' })
      const renamedProvider = createProvider({ name: 'New Name' })

      expect(getProviderModelSyncFingerprint(renamedProvider)).toBe(getProviderModelSyncFingerprint(provider))
    })

    it('changes when api key or api host changes', () => {
      const provider = createProvider({ apiKey: 'old-key', apiHost: 'https://old.example.com/v1' })

      expect(
        getProviderModelSyncFingerprint(createProvider({ apiKey: 'new-key', apiHost: provider.apiHost }))
      ).not.toBe(getProviderModelSyncFingerprint(provider))
      expect(
        getProviderModelSyncFingerprint(
          createProvider({ apiKey: provider.apiKey, apiHost: 'https://new.example.com/v1' })
        )
      ).not.toBe(getProviderModelSyncFingerprint(provider))
    })
  })

  describe('markProviderModelSyncFailed', () => {
    it('records a failed attempt without changing models', () => {
      const provider = createProvider({
        models: [createModel('remote-a')],
        modelSync: {
          remoteModelIds: ['remote-a'],
          syncedAt: 100,
          sourceFingerprint: 'old-fingerprint',
          lastSuccessAt: 100
        }
      })

      const nextProvider = markProviderModelSyncFailed(provider, {
        sourceFingerprint: 'new-fingerprint',
        attemptedAt: 300
      })

      expect(nextProvider.models).toBe(provider.models)
      expect(nextProvider.modelSync).toEqual({
        remoteModelIds: ['remote-a'],
        syncedAt: 100,
        sourceFingerprint: 'new-fingerprint',
        lastAttemptAt: 300,
        lastSuccessAt: 100,
        lastFailureAt: 300
      })
    })
  })
})
