import { getEffectiveModelEndpointType, isNotSupportTextDeltaModel } from '@renderer/config/models'
import type { Model, Provider } from '@renderer/types'
import { uniqBy } from 'lodash'

const normalizeSyncSourceValue = (value: string | undefined) => (value ?? '').trim().replace(/\/+$/, '')

const hashSyncSourceValue = (value: string | undefined): string => {
  const input = value ?? ''
  let hash = 2166136261

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0).toString(36)
}

export const getProviderModelSyncFingerprint = (provider: Provider): string =>
  JSON.stringify({
    id: provider.id,
    type: provider.type,
    apiHost: normalizeSyncSourceValue(provider.apiHost),
    anthropicApiHost: normalizeSyncSourceValue(provider.anthropicApiHost),
    apiVersion: normalizeSyncSourceValue(provider.apiVersion),
    authType: provider.authType ?? '',
    apiKeyHash: hashSyncSourceValue(provider.apiKey)
  })

export const normalizeSyncedModel = (provider: Provider, model: Model): Model => {
  return {
    ...model,
    provider: provider.id,
    endpoint_type: getEffectiveModelEndpointType(model, provider),
    supported_text_delta: !isNotSupportTextDeltaModel(model)
  }
}

const mergeExistingModelMetadata = (
  existingModel: Model,
  remoteModel: Model,
  remoteDeclaresEndpoint: boolean
): Model => {
  const preserveUserCapacity = existingModel.contextCapacitySource === 'user'
  return {
    ...remoteModel,
    endpoint_type: remoteDeclaresEndpoint
      ? (remoteModel.endpoint_type ?? existingModel.endpoint_type)
      : (existingModel.endpoint_type ?? remoteModel.endpoint_type),
    supported_endpoint_types: remoteModel.supported_endpoint_types ?? existingModel.supported_endpoint_types,
    contextWindowTokens: preserveUserCapacity
      ? (existingModel.contextWindowTokens ?? remoteModel.contextWindowTokens)
      : (remoteModel.contextWindowTokens ?? existingModel.contextWindowTokens),
    maxOutputTokens: preserveUserCapacity
      ? (existingModel.maxOutputTokens ?? remoteModel.maxOutputTokens)
      : (remoteModel.maxOutputTokens ?? existingModel.maxOutputTokens),
    contextCapacitySource: preserveUserCapacity
      ? existingModel.contextCapacitySource
      : (remoteModel.contextCapacitySource ?? existingModel.contextCapacitySource),
    contextCapacityConfidence: preserveUserCapacity
      ? existingModel.contextCapacityConfidence
      : (remoteModel.contextCapacityConfidence ?? existingModel.contextCapacityConfidence)
  }
}

export const mergeSyncedProviderModels = (
  provider: Provider,
  fetchedModels: Model[],
  options?: {
    preserveModelIds?: string[]
    syncedAt?: number
    sourceFingerprint?: string
    attemptedAt?: number
  }
): Provider => {
  const remoteModels = uniqBy(
    fetchedModels
      .filter((model) => model.id?.trim() && model.name?.trim())
      .map((model) => normalizeSyncedModel(provider, model)),
    'id'
  )

  if (remoteModels.length === 0) {
    return provider
  }

  const previousRemoteIds = new Set(provider.modelSync?.remoteModelIds ?? [])
  const nextRemoteIds = new Set(remoteModels.map((model) => model.id))
  const preserveModelIds = new Set(options?.preserveModelIds ?? [])
  const remoteModelById = new Map(remoteModels.map((model) => [model.id, model]))
  const remoteEndpointDeclarations = new Map(
    fetchedModels.map((model) => [
      model.id,
      Boolean(model.endpoint_type || (model.supported_endpoint_types && model.supported_endpoint_types.length > 0))
    ])
  )

  const keptExistingModels = provider.models
    .filter((model) => {
      if (preserveModelIds.has(model.id)) {
        return true
      }

      if (!previousRemoteIds.has(model.id)) {
        return true
      }

      return nextRemoteIds.has(model.id)
    })
    .map((model) => {
      const remoteModel = remoteModelById.get(model.id)
      return remoteModel
        ? mergeExistingModelMetadata(model, remoteModel, remoteEndpointDeclarations.get(remoteModel.id) === true)
        : model
    })

  const mergedModels = uniqBy([...keptExistingModels, ...remoteModels], 'id')

  return {
    ...provider,
    models: mergedModels,
    modelSync: {
      remoteModelIds: Array.from(nextRemoteIds),
      syncedAt: options?.syncedAt ?? Date.now(),
      sourceFingerprint: options?.sourceFingerprint ?? getProviderModelSyncFingerprint(provider),
      lastAttemptAt: options?.attemptedAt ?? options?.syncedAt ?? Date.now(),
      lastSuccessAt: options?.syncedAt ?? Date.now(),
      lastFailureAt: provider.modelSync?.lastFailureAt
    }
  }
}

export const markProviderModelSyncFailed = (
  provider: Provider,
  options: {
    sourceFingerprint: string
    attemptedAt: number
  }
): Provider => ({
  ...provider,
  modelSync: {
    remoteModelIds: provider.modelSync?.remoteModelIds ?? [],
    syncedAt: provider.modelSync?.syncedAt ?? 0,
    sourceFingerprint: options.sourceFingerprint,
    lastAttemptAt: options.attemptedAt,
    lastSuccessAt: provider.modelSync?.lastSuccessAt,
    lastFailureAt: options.attemptedAt
  }
})
