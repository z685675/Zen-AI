/** Intent is separate from the temporary effective selection. No prompts,
 * credentials or message history belong in this record. */
export type ModelRecoveryIntent = {
  preferred: string
  actual: string | null
  recoveredAt?: number
  unavailableAt?: number
  recoveryDelayMs?: number
}

export const MODEL_RECOVERY_STABILITY_MS = 5 * 60_000

export function selectRecoverableModel(input: {
  current?: string | null
  preferred?: string
  available: readonly string[]
  fallbacks: readonly string[]
  intent?: ModelRecoveryIntent
  now: number
  manual?: boolean
}): { selected: string | null; intent?: ModelRecoveryIntent } {
  const current = input.current || null
  const available = new Set(input.available)
  let intent = input.intent ? { ...input.intent } : undefined
  // A changed selection (including a manual clear) supersedes an old repair.
  if (input.manual || (intent && current !== intent.actual)) intent = undefined
  const preferred = intent?.preferred || current || input.preferred
  if (!preferred) return { selected: current }
  intent ??= { preferred, actual: current }
  const primaryAvailable = available.has(preferred)
  const currentAvailable = current !== null && available.has(current)
  if (!primaryAvailable) {
    if (intent.recoveredAt !== undefined) {
      intent.recoveryDelayMs = Math.min(
        15 * 60_000,
        Math.max(MODEL_RECOVERY_STABILITY_MS, intent.recoveryDelayMs ?? 0) * 2
      )
    }
    intent.recoveredAt = undefined
    intent.unavailableAt ??= input.now
  } else if (intent.unavailableAt !== undefined && intent.recoveredAt === undefined) {
    intent.recoveredAt = input.now
  }
  let selected: string | null
  if (
    primaryAvailable &&
    (current === preferred ||
      !currentAvailable ||
      intent.unavailableAt === undefined ||
      input.now - (intent.recoveredAt ?? input.now) >=
        Math.max(MODEL_RECOVERY_STABILITY_MS, intent.recoveryDelayMs ?? 0))
  ) {
    selected = preferred
  } else if (currentAvailable) {
    selected = current
  } else {
    selected = [...new Set(input.fallbacks)].find((model) => available.has(model)) ?? null
  }
  intent.actual = selected
  return { selected, intent }
}

/** Text fallbacks never silently cross provider, key or model-purpose boundaries. */
export const isTextFallbackIdentifier = (id: string): boolean =>
  !/(?:embedding|rerank|gpt-image|dall-e|imagen|grok-imagine|image-generation|text-to-image|(?:^|[-_/])(?:image|imagine|flux|sdxl|stable-diffusion)(?:$|[-_/])|video|veo-|sora|whisper|tts|audio|speech)/i.test(
    id
  )
