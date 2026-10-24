import type { Provider } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { imageCanvasProviders } from '../imageCanvasProviders'

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'custom',
    name: 'Custom',
    type: 'openai',
    enabled: true,
    apiHost: 'https://proxy.example/custom#',
    apiKey: 'private-key',
    models: [
      {
        id: 'custom-image-name',
        name: 'Custom image',
        group: 'Images',
        provider: 'custom',
        endpoint_type: 'image-generation'
      }
    ],
    ...overrides
  }
}
describe('canvas provider catalog', () => {
  it('allows an existing keyless image provider so a ComfyUI transport can be configured', () => {
    const result = imageCanvasProviders([provider({ apiHost: 'http://192.168.1.20:8188', apiKey: '' })])
    expect(result).toHaveLength(1)
    expect(result[0].apiKey).toBe('')
    // The main-process OpenAI validator still requires a key until explicitly
    // selecting the ComfyUI transport for this provider/model.
  })
  it('uses configured endpoint declarations for custom model names', () => {
    expect(imageCanvasProviders([provider()])[0]).toMatchObject({
      apiHost: 'https://proxy.example/custom#',
      models: [{ id: 'custom-image-name', protocol: 'openai' }]
    })
  })
  it('includes native Gemini images while excluding text, Vertex and OAuth', () => {
    const gemini = provider({
      id: 'gemini',
      type: 'gemini',
      models: ['gemini-2.5-flash-image', 'gemini-2.5-pro'].map((id) => ({
        id,
        name: id,
        provider: 'gemini',
        group: 'Gemini'
      }))
    })
    const result = imageCanvasProviders([gemini, provider({ isVertex: true }), provider({ authType: 'oauth' })])
    expect(result).toHaveLength(1)
    expect(result[0].models).toEqual([
      { id: 'gemini-2.5-flash-image', name: 'gemini-2.5-flash-image', protocol: 'gemini' }
    ])
  })
  it('selects Ark for Seedream and tolerates incomplete provider URLs', () => {
    const result = imageCanvasProviders([
      provider({ apiHost: 'invalid host' }),
      provider({ apiHost: 'https://ark.cn-beijing.volces.com/api/v3' })
    ])
    expect(result).toHaveLength(1)
    expect(result[0].models[0].protocol).toBe('seedream')
  })
})
