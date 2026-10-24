import { isImageGenerationEndpointModel } from '@renderer/config/models'
import type { Provider } from '@renderer/types'
import type { ImageCanvasProtocol, ImageCanvasProvider } from '@shared/config/imageCanvas'

export function imageCanvasProviders(providers: Provider[]): ImageCanvasProvider[] {
  return providers
    .filter(
      (provider) =>
        provider.enabled &&
        provider.authType !== 'oauth' &&
        !provider.isVertex &&
        ['openai', 'openai-response', 'new-api', 'gateway', 'gemini'].includes(provider.type) &&
        provider.apiHost
    )
    .map((provider): ImageCanvasProvider | undefined => {
      const nativeGemini = provider.type === 'gemini' && !provider.isVertex
      let hostname = ''
      try {
        hostname = new URL(provider.apiHost.replace(/#$/, '')).hostname
      } catch {
        return undefined
      }
      const nativeSeedream = /(?:^|\.)volces\.com$/.test(hostname) || provider.id === 'volcengine'
      const nativeDashscope =
        /(?:^|\.)(?:dashscope(?:-intl|-us)?\.aliyuncs\.com|dashscope\.[a-z-]+\.aliyuncs\.com|[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com)$/.test(
          hostname
        )
      let protocol: ImageCanvasProtocol = 'openai'
      if (nativeGemini) protocol = 'gemini'
      else if (nativeSeedream) protocol = 'seedream'
      else if (nativeDashscope) protocol = 'dashscope'
      return {
        id: provider.id,
        name: provider.name,
        apiHost: provider.apiHost,
        apiKey: provider.apiKey,
        headers: provider.extra_headers,
        models: provider.models
          .filter(
            (model) =>
              isImageGenerationEndpointModel(model, provider) ||
              (nativeGemini
                ? /(?:gemini.*image|nano.banana)/i.test(model.id)
                : /(?:gpt-image|gptimage|dall-e|seedream|grok-imagine-image|qwen.*image|wan.*(?:t2i|i2i|image))/i.test(
                    model.id
                  ))
          )
          .map((model) => ({
            id: model.id,
            name: model.name || model.id,
            protocol:
              model.endpoint_type === 'gemini'
                ? ('gemini' as const)
                : model.endpoint_type === 'image-generation' && nativeGemini
                  ? ('openai' as const)
                  : protocol
          }))
      }
    })
    .filter((provider): provider is ImageCanvasProvider => !!provider && provider.models.length > 0)
}
