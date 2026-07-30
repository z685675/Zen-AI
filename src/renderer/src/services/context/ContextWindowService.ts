import type { Model, Provider } from '@renderer/types'
import type { ModelMessage } from 'ai'
import { approximateTokenSize } from 'tokenx'

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000
export const DEFAULT_NEW_API_CONTEXT_WINDOW_TOKENS = 256_000
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 32_000
export const MIN_OUTPUT_RESERVE_TOKENS = 8_000
export const MAX_OUTPUT_RESERVE_TOKENS = 32_000
export const CONTEXT_SAFETY_RATIO = 0.9
export const CONTEXT_COMPACTION_TRIGGER_RATIO = 0.9
export const CONTEXT_COMPACTION_TARGET_RATIO = 0.58
export const DEFAULT_IMAGE_TOKEN_ESTIMATE = 1_700
export const MAX_DIRECT_IMAGE_COUNT = 20
export const MIN_ADAPTIVE_CONTEXT_WINDOW_TOKENS = 32_000

const ADAPTIVE_CONTEXT_KEY_PREFIX = 'unified-context-adaptive-capacity:'
const ADAPTIVE_CONTEXT_TTL_MS = 30 * 24 * 60 * 60 * 1_000

export type ModelContextProfile = {
  contextWindowTokens: number
  maxOutputTokens: number
  source: NonNullable<Model['contextCapacitySource']>
  confidence: NonNullable<Model['contextCapacityConfidence']>
}

export type ContextBudget = ModelContextProfile & {
  safetyRatio: number
  fixedInputTokens: number
  safeInputTokens: number
  compactionTriggerTokens: number
  compactionTargetTokens: number
}

export type ContextUsageEstimate = {
  textTokens: number
  imageTokens: number
  fileTokens: number
  totalTokens: number
}

export type ContextWindowPlan = {
  action: 'full' | 'compact'
  budget: ContextBudget
  usage: ContextUsageEstimate
  splitIndex: number
  recentMessages: ModelMessage[]
  messagesToCompact: ModelMessage[]
}

const NEW_API_PROVIDER_IDS = new Set(['new-api', 'cherryin'])

const normalizePositiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

const isNewApiLikeProvider = (provider?: Provider): boolean =>
  !!provider && (provider.type === 'new-api' || NEW_API_PROVIDER_IDS.has(provider.id))

const adaptiveContextKey = (model: Model, provider?: Provider): string =>
  `${ADAPTIVE_CONTEXT_KEY_PREFIX}${provider?.id ?? model.provider}:${model.id}`

export function getAdaptiveContextWindowTokens(model: Model, provider?: Provider): number | undefined {
  if (typeof window === 'undefined' || !window.keyv) {
    return undefined
  }
  const key = adaptiveContextKey(model, provider)
  const stored = window.keyv.get(key)
  if (stored && typeof stored === 'object') {
    const record = stored as { tokens?: unknown; updatedAt?: unknown }
    const updatedAt = typeof record.updatedAt === 'string' ? Date.parse(record.updatedAt) : Number(record.updatedAt)
    if (Number.isFinite(updatedAt) && Date.now() - updatedAt > ADAPTIVE_CONTEXT_TTL_MS) {
      window.keyv.remove(key)
      return undefined
    }
    return normalizePositiveInteger(record.tokens)
  }
  return normalizePositiveInteger(stored)
}

export function recordAdaptiveContextFailure({
  model,
  provider,
  failedInputTokens,
  maxOutputTokens,
  currentContextWindowTokens
}: {
  model: Model
  provider?: Provider
  failedInputTokens: number
  maxOutputTokens: number
  currentContextWindowTokens: number
}): number {
  const previous = getAdaptiveContextWindowTokens(model, provider)
  const failedRequestCapacity = Math.max(1, failedInputTokens) + Math.max(0, maxOutputTokens)
  const learnedCapacity = Math.max(
    MIN_ADAPTIVE_CONTEXT_WINDOW_TOKENS,
    Math.floor(Math.min(currentContextWindowTokens, failedRequestCapacity) * 0.72)
  )
  const nextCapacity = previous ? Math.min(previous, learnedCapacity) : learnedCapacity

  if (typeof window !== 'undefined' && window.keyv) {
    window.keyv.set(adaptiveContextKey(model, provider), {
      tokens: nextCapacity,
      updatedAt: new Date().toISOString()
    })
  }
  return nextCapacity
}

export function clearAdaptiveContextWindowTokens(model: Model, provider?: Provider): void {
  if (typeof window !== 'undefined' && window.keyv) {
    window.keyv.remove(adaptiveContextKey(model, provider))
  }
}

export function isContextCapacityError(error: unknown): boolean {
  const parts: string[] = []
  let current: unknown = error
  const visited = new Set<unknown>()

  while (current && !visited.has(current) && parts.length < 8) {
    visited.add(current)
    if (typeof current === 'string') {
      parts.push(current)
      break
    }
    if (current instanceof Error) {
      parts.push(current.name, current.message)
      current = current.cause
      continue
    }
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>
      for (const key of ['message', 'code', 'type', 'error', 'detail']) {
        const value = record[key]
        if (typeof value === 'string') parts.push(value)
      }
      current = record.cause
      continue
    }
    parts.push(String(current))
    break
  }

  const normalized = parts.join(' ').toLocaleLowerCase()
  return [
    'context_length_exceeded',
    'context window',
    'context length',
    'maximum context',
    'max context',
    'too many tokens',
    'token limit',
    'input is too long',
    'prompt is too long',
    'request too large',
    '上下文过长',
    '上下文长度',
    '超过上下文',
    'token 超限'
  ].some((pattern) => normalized.includes(pattern))
}

export function resolveModelContextProfile(model: Model, provider?: Provider): ModelContextProfile {
  const explicitContextWindow = normalizePositiveInteger(model.contextWindowTokens)
  const configuredContextWindowTokens =
    explicitContextWindow ??
    (isNewApiLikeProvider(provider) ? DEFAULT_NEW_API_CONTEXT_WINDOW_TOKENS : DEFAULT_CONTEXT_WINDOW_TOKENS)
  const adaptiveContextWindowTokens = getAdaptiveContextWindowTokens(model, provider)
  const contextWindowTokens = adaptiveContextWindowTokens
    ? Math.min(configuredContextWindowTokens, adaptiveContextWindowTokens)
    : configuredContextWindowTokens
  const reportedOutputLimit = normalizePositiveInteger(model.maxOutputTokens)
  const maxOutputTokens = Math.min(
    MAX_OUTPUT_RESERVE_TOKENS,
    Math.max(MIN_OUTPUT_RESERVE_TOKENS, reportedOutputLimit ?? DEFAULT_OUTPUT_RESERVE_TOKENS)
  )

  return {
    contextWindowTokens,
    maxOutputTokens,
    source:
      adaptiveContextWindowTokens && adaptiveContextWindowTokens < configuredContextWindowTokens
        ? 'adaptive'
        : explicitContextWindow
          ? (model.contextCapacitySource ?? 'provider')
          : 'fallback',
    confidence:
      adaptiveContextWindowTokens && adaptiveContextWindowTokens < configuredContextWindowTokens
        ? 'medium'
        : explicitContextWindow
          ? (model.contextCapacityConfidence ?? 'medium')
          : 'low'
  }
}

export function createContextBudget({
  model,
  provider,
  fixedInputTokens = 0,
  requestedOutputTokens
}: {
  model: Model
  provider?: Provider
  fixedInputTokens?: number
  requestedOutputTokens?: number
}): ContextBudget {
  const profile = resolveModelContextProfile(model, provider)
  const requestedReserve = normalizePositiveInteger(requestedOutputTokens)
  const maxOutputTokens = requestedReserve
    ? Math.min(MAX_OUTPUT_RESERVE_TOKENS, Math.max(MIN_OUTPUT_RESERVE_TOKENS, requestedReserve))
    : profile.maxOutputTokens
  const normalizedFixedInputTokens = Math.max(0, Math.floor(fixedInputTokens))
  const safeInputTokens = Math.max(
    MIN_OUTPUT_RESERVE_TOKENS,
    Math.floor((profile.contextWindowTokens - maxOutputTokens) * CONTEXT_SAFETY_RATIO) - normalizedFixedInputTokens
  )

  return {
    ...profile,
    maxOutputTokens,
    safetyRatio: CONTEXT_SAFETY_RATIO,
    fixedInputTokens: normalizedFixedInputTokens,
    safeInputTokens,
    compactionTriggerTokens: Math.floor(safeInputTokens * CONTEXT_COMPACTION_TRIGGER_RATIO),
    compactionTargetTokens: Math.floor(safeInputTokens * CONTEXT_COMPACTION_TARGET_RATIO)
  }
}

const estimateEncodedPayloadTokens = (value: unknown): number => {
  if (typeof value === 'string') {
    if (value.startsWith('data:')) {
      const encoded = value.slice(value.indexOf(',') + 1)
      return Math.ceil((encoded.length * 0.75) / 3)
    }
    return approximateTokenSize(value)
  }

  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return Math.ceil(value.byteLength / 3)
  }

  return 0
}

function estimateContentPart(part: unknown): ContextUsageEstimate {
  const empty: ContextUsageEstimate = { textTokens: 0, imageTokens: 0, fileTokens: 0, totalTokens: 0 }
  if (!part || typeof part !== 'object') {
    return empty
  }

  const record = part as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''

  if (type === 'text' || type === 'reasoning') {
    const textTokens = approximateTokenSize(typeof record.text === 'string' ? record.text : '')
    return { ...empty, textTokens, totalTokens: textTokens }
  }

  if (type === 'image') {
    return { ...empty, imageTokens: DEFAULT_IMAGE_TOKEN_ESTIMATE, totalTokens: DEFAULT_IMAGE_TOKEN_ESTIMATE }
  }

  if (type === 'file') {
    const mediaType = typeof record.mediaType === 'string' ? record.mediaType : ''
    if (mediaType.startsWith('image/')) {
      return { ...empty, imageTokens: DEFAULT_IMAGE_TOKEN_ESTIMATE, totalTokens: DEFAULT_IMAGE_TOKEN_ESTIMATE }
    }
    const fileTokens = Math.max(
      approximateTokenSize(String(record.filename ?? '')),
      estimateEncodedPayloadTokens(record.data)
    )
    return { ...empty, fileTokens, totalTokens: fileTokens }
  }

  const textTokens = typeof record.content === 'string' ? approximateTokenSize(record.content) : 0
  return { ...empty, textTokens, totalTokens: textTokens }
}

export function estimateModelMessageTokens(message: ModelMessage): ContextUsageEstimate {
  if (typeof message.content === 'string') {
    const textTokens = approximateTokenSize(message.content)
    return { textTokens, imageTokens: 0, fileTokens: 0, totalTokens: textTokens }
  }

  if (!Array.isArray(message.content)) {
    return { textTokens: 0, imageTokens: 0, fileTokens: 0, totalTokens: 0 }
  }

  return message.content.reduce<ContextUsageEstimate>(
    (total, part) => {
      const estimate = estimateContentPart(part)
      total.textTokens += estimate.textTokens
      total.imageTokens += estimate.imageTokens
      total.fileTokens += estimate.fileTokens
      total.totalTokens += estimate.totalTokens
      return total
    },
    { textTokens: 0, imageTokens: 0, fileTokens: 0, totalTokens: 0 }
  )
}

export function estimateModelMessagesTokens(messages: ModelMessage[]): ContextUsageEstimate {
  return messages.reduce<ContextUsageEstimate>(
    (total, message) => {
      const estimate = estimateModelMessageTokens(message)
      total.textTokens += estimate.textTokens
      total.imageTokens += estimate.imageTokens
      total.fileTokens += estimate.fileTokens
      total.totalTokens += estimate.totalTokens
      return total
    },
    { textTokens: 0, imageTokens: 0, fileTokens: 0, totalTokens: 0 }
  )
}

export function countModelMessageImages(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => {
    if (!Array.isArray(message.content)) {
      return total
    }
    return (
      total +
      message.content.filter((part) => {
        if (!part || typeof part !== 'object') {
          return false
        }
        const record = part as Record<string, unknown>
        return (
          record.type === 'image' ||
          (record.type === 'file' && typeof record.mediaType === 'string' && record.mediaType.startsWith('image/'))
        )
      }).length
    )
  }, 0)
}

export function planContextWindow(messages: ModelMessage[], budget: ContextBudget): ContextWindowPlan {
  const usage = estimateModelMessagesTokens(messages)
  if (
    usage.totalTokens <= budget.compactionTriggerTokens &&
    countModelMessageImages(messages) <= MAX_DIRECT_IMAGE_COUNT
  ) {
    return {
      action: 'full',
      budget,
      usage,
      splitIndex: 0,
      recentMessages: messages,
      messagesToCompact: []
    }
  }

  let recentTokens = 0
  let splitIndex = messages.length

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const messageTokens = estimateModelMessageTokens(messages[index]).totalTokens
    if (recentTokens > 0 && recentTokens + messageTokens > budget.compactionTargetTokens) {
      break
    }
    recentTokens += messageTokens
    splitIndex = index
  }

  while (splitIndex < messages.length && messages[splitIndex].role !== 'user') {
    splitIndex += 1
  }

  if (splitIndex >= messages.length) {
    splitIndex = Math.max(0, messages.length - 1)
  }

  return {
    action: 'compact',
    budget,
    usage,
    splitIndex,
    recentMessages: messages.slice(splitIndex),
    messagesToCompact: messages.slice(0, splitIndex)
  }
}
