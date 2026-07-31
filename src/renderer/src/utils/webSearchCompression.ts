import type { CompressionConfig } from '@renderer/store/websearch'

export function getEffectiveWebSearchCompression(
  _persistedConfig: CompressionConfig | undefined
): CompressionConfig | undefined {
  // The unified search entry must remain keyless and must not depend on an
  // embedding model inherited from legacy provider settings.
  void _persistedConfig
  return undefined
}
