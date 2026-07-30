import { describe, expect, it } from 'vitest'

import { getAgentRuntimeCapabilities, getAgentRuntimeCompatibility } from '../compatibility'

describe('getAgentRuntimeCapabilities', () => {
  it('marks Anthropic providers as declared for Claude Code without excluding an unverified Codex path', () => {
    const capabilities = getAgentRuntimeCapabilities({ type: 'anthropic' }, undefined)

    expect(capabilities['claude-code'].state).toBe('declared')
    expect(capabilities.codex.state).toBe('unknown')
  })

  it('keeps an OpenAI provider eligible for Claude Code through the protocol bridge', () => {
    const capabilities = getAgentRuntimeCapabilities({ type: 'openai' }, { endpoint_type: 'openai' })

    expect(capabilities['claude-code'].state).toBe('declared')
    expect(capabilities['claude-code'].evidence).toContain('zen-protocol-bridge-openai-chat')
    expect(capabilities.codex.state).toBe('declared')
    expect(getAgentRuntimeCompatibility({ type: 'openai' }, { endpoint_type: 'openai' })).toEqual([
      'claude-code',
      'codex'
    ])
  })

  it('uses a configured Anthropic host even when the provider type is OpenAI', () => {
    const capabilities = getAgentRuntimeCapabilities(
      { type: 'openai', anthropicApiHost: 'https://gateway.example.com/anthropic' },
      undefined
    )

    expect(capabilities['claude-code'].state).toBe('declared')
    expect(capabilities.codex.state).toBe('declared')
  })

  it('declares the New API chat bridge while leaving Codex Responses unverified without model metadata', () => {
    const capabilities = getAgentRuntimeCapabilities({ type: 'new-api' }, undefined)

    expect(capabilities['claude-code']).toEqual({
      state: 'declared',
      evidence: ['zen-protocol-bridge-openai-chat']
    })
    expect(capabilities.codex.state).toBe('unknown')
  })

  it('uses supported endpoint metadata as an explicit capability boundary', () => {
    const capabilities = getAgentRuntimeCapabilities({ type: 'new-api' }, { supported_endpoint_types: ['anthropic'] })

    expect(capabilities['claude-code'].state).toBe('declared')
    expect(capabilities.codex.state).toBe('unsupported')
  })

  it('supports models that advertise both endpoint protocols', () => {
    const capabilities = getAgentRuntimeCapabilities(
      { type: 'new-api' },
      { supported_endpoint_types: ['anthropic', 'openai-response'] }
    )

    expect(capabilities['claude-code'].state).toBe('declared')
    expect(capabilities.codex.state).toBe('declared')
  })

  it('supports native Gemini through the Claude Code protocol bridge', () => {
    const capabilities = getAgentRuntimeCapabilities(
      { id: 'gemini', type: 'gemini' },
      { id: 'gemini-2.5-pro', supported_endpoint_types: ['gemini'] }
    )

    expect(capabilities['claude-code']).toMatchObject({
      state: 'declared',
      evidence: ['zen-protocol-bridge-gemini']
    })
    expect(capabilities.codex.state).toBe('unsupported')
  })
})
