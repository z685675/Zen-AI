import { describe, expect, it } from 'vitest'

import { getAgentProtocolBridgeTarget, shouldUseAgentProtocolBridge } from '../protocol'

describe('Agent protocol bridge policy', () => {
  it('uses the native Gemini adapter for Gemini providers', () => {
    const provider = { id: 'gemini', type: 'gemini' }
    const model = { id: 'gemini-2.5-pro', endpoint_type: 'gemini' }

    expect(getAgentProtocolBridgeTarget(provider, model)).toBe('gemini')
    expect(shouldUseAgentProtocolBridge(provider, model)).toBe(true)
  })

  it('uses the provider protocol instead of the Grok model family', () => {
    const provider = { id: 'grok', type: 'openai' }
    const model = { id: 'grok-4' }

    expect(getAgentProtocolBridgeTarget(provider, model)).toBe('openai-chat')
  })

  it('uses OpenAI Chat for Gemini and Grok models imported through an OpenAI-compatible panel', () => {
    const provider = { id: 'custom-panel', type: 'openai' }

    expect(getAgentProtocolBridgeTarget(provider, { id: 'gemini-2.5-pro' })).toBe('openai-chat')
    expect(getAgentProtocolBridgeTarget(provider, { id: 'grok-4' })).toBe('openai-chat')
  })

  it('uses Responses only when the provider or model declares that protocol', () => {
    expect(
      getAgentProtocolBridgeTarget({ id: 'responses-panel', type: 'openai-response' }, { id: 'gpt-compatible-model' })
    ).toBe('openai-responses')
  })

  it('uses the provider default when a gateway reports multiple supported protocols', () => {
    const provider = { id: 'mixed-panel', type: 'new-api' }
    const model = { id: 'claude-opus-4-6', supported_endpoint_types: ['anthropic', 'openai'] }

    expect(getAgentProtocolBridgeTarget(provider, model)).toBe('openai-chat')
    expect(shouldUseAgentProtocolBridge(provider, model)).toBe(true)
  })

  it('keeps an explicitly selected Anthropic endpoint on the direct Claude Code path', () => {
    const provider = { id: 'mixed-panel', type: 'new-api' }
    const model = {
      id: 'claude-opus-4-6',
      endpoint_type: 'anthropic',
      supported_endpoint_types: ['anthropic', 'openai']
    }

    expect(getAgentProtocolBridgeTarget(provider, model)).toBeUndefined()
    expect(shouldUseAgentProtocolBridge(provider, model)).toBe(false)
  })

  it('prefers a configured Anthropic host over a generic bridge', () => {
    const provider = {
      id: 'custom-panel',
      type: 'openai',
      anthropicApiHost: 'https://panel.example.com/anthropic'
    }

    expect(shouldUseAgentProtocolBridge(provider, { id: 'gemini-pro' })).toBe(false)
  })
})
