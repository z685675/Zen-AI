import type { Model, Provider } from '@renderer/types'

import { getProviderApiKeys, orderChatApiKeys, shouldRotateChatApiKey } from '../chatKeyFailover'

export type ContextCompactionKeyRequest = {
  model: Model
  provider: Provider
  prompt: string
  content: string
  apiKey?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxOutputTokens?: number
}

type KeyValueStore = {
  get: (key: string) => unknown
  set: (key: string, value: unknown) => unknown
}

export type CreateContextCompactionKeyFailoverOptions = {
  topicId?: string
  resolveProvider: (model: Model) => Provider
  generate: (request: ContextCompactionKeyRequest) => Promise<string>
  keyValueStore?: KeyValueStore
  onKeyRotation?: (details: { model: Model; fromIndex: number; toIndex: number; statusCode?: number }) => void
}

type ContextCompactionKeyState = {
  keys: string[]
  index: number
  scope?: string
}

const selectStableKey = (
  provider: Provider,
  topicId: string | undefined,
  modelId: string | undefined,
  storage?: KeyValueStore
): string => {
  const keys = getProviderApiKeys(provider.apiKey)
  if (keys.length <= 1 || !topicId || !modelId) return keys[0] ?? ''

  const scope = `provider:${provider.id}:context_compaction_key:${topicId}:${modelId}`
  const stored = storage?.get(scope)
  if (typeof stored === 'string' && keys.includes(stored)) return stored

  // Keep all chunks and merge requests in a single checkpoint operation on
  // one key. This preserves prompt caching and route consistency.
  let hash = 2166136261
  for (const char of `${provider.id}:${topicId}:${modelId}:context-compaction`) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  const selectedKey = keys[(hash >>> 0) % keys.length]
  storage?.set(scope, selectedKey)
  return selectedKey
}

/**
 * Keep API-key selection stable throughout one checkpoint operation. Rotate
 * only for credential-scoped failures; the enclosing model generator can then
 * move to the next configured model after every key for this model has failed.
 */
export const createContextCompactionKeyFailover = ({
  topicId,
  resolveProvider,
  generate,
  keyValueStore,
  onKeyRotation
}: CreateContextCompactionKeyFailoverOptions) => {
  const states = new Map<string, ContextCompactionKeyState>()
  const storage =
    keyValueStore ??
    (typeof window !== 'undefined' && window.keyv
      ? {
          get: (key: string) => window.keyv.get(key),
          set: (key: string, value: unknown) => window.keyv.set(key, value)
        }
      : undefined)

  return async ({
    model,
    prompt,
    content,
    signal,
    timeoutMs,
    maxOutputTokens
  }: Omit<ContextCompactionKeyRequest, 'provider' | 'apiKey'>): Promise<string> => {
    const provider = resolveProvider(model)
    const stateKey = `${provider.id}:${model.id}`.toLowerCase()
    let state = states.get(stateKey)

    if (!state) {
      const stableKey = selectStableKey(provider, topicId, model.id, storage)
      const keys = orderChatApiKeys(provider, stableKey)
      state = {
        keys,
        index: 0,
        ...(topicId && model.id
          ? { scope: `provider:${provider.id}:context_compaction_key:${topicId}:${model.id}` }
          : {})
      }
      states.set(stateKey, state)
    }

    while (true) {
      const activeKey = state.keys[state.index]
      try {
        return await generate({
          model,
          provider,
          prompt,
          content,
          ...(activeKey !== undefined ? { apiKey: activeKey } : {}),
          signal,
          timeoutMs,
          maxOutputTokens
        })
      } catch (error) {
        const nextIndex = state.index + 1
        if (!shouldRotateChatApiKey(error) || nextIndex >= state.keys.length) throw error

        const previousIndex = state.index
        state.index = nextIndex
        const nextKey = state.keys[state.index]
        if (state.scope && nextKey) storage?.set(state.scope, nextKey)
        onKeyRotation?.({
          model,
          fromIndex: previousIndex + 1,
          toIndex: state.index + 1,
          statusCode: getStatusCode(error)
        })
      }
    }
  }
}

const getStatusCode = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  const status = record.statusCode ?? record.status
  if (typeof status === 'number') return status
  if (typeof status === 'string' && /^\d{3}$/.test(status)) return Number(status)
  return undefined
}
