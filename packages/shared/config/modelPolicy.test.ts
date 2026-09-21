import { describe, expect, it } from 'vitest'

import { isModelPolicy, type ModelPolicy, normalizeModelPolicy } from './modelPolicy'

const createPolicy = (contextCompactionModels?: string[]): ModelPolicy => ({
  schemaVersion: 1,
  version: 1,
  defaults: {
    chat: 'gpt-5.6-luna',
    quick: 'gpt-5.6-luna',
    translate: 'gpt-5.6-luna',
    assistant: 'gpt-5.6-luna',
    assistantNewSession: 'gpt-5.6-luna',
    ...(contextCompactionModels === undefined ? {} : { contextCompactionModels })
  },
  assistant: {
    nonDeveloperAllowlist: ['gpt-5.6-luna'],
    developerAllowlist: [],
    blockedModels: [],
    fallbackModels: []
  },
  rules: {
    applyToNewSessions: true,
    overwriteUserChoice: false,
    preserveExistingSessions: true,
    developerModeBypassAllowlist: true
  }
})

describe('remote model policy context compaction settings', () => {
  it('accepts policies published before the context model setting existed', () => {
    expect(isModelPolicy(createPolicy())).toBe(true)
  })

  it('accepts and normalizes up to three ordered models', () => {
    const policy = createPolicy([' model-a ', 'model-b', 'model-c'])
    expect(isModelPolicy(policy)).toBe(true)
    expect(normalizeModelPolicy(policy).defaults.contextCompactionModels).toEqual(['model-a', 'model-b', 'model-c'])
  })

  it('rejects more than three context compaction models', () => {
    expect(isModelPolicy(createPolicy(['model-a', 'model-b', 'model-c', 'model-d']))).toBe(false)
  })
})
