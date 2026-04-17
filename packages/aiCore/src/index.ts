/**
 * Zen AI AI Core Package
 * 鍩轰簬 Vercel AI SDK 鐨勭粺涓€ AI Provider 鎺ュ彛
 */

// 瀵煎叆鍐呴儴浣跨敤鐨勭被鍜屽嚱鏁?
// ==================== 涓昏鐢ㄦ埛鎺ュ彛 ====================
export { createExecutor, embedMany, generateImage, generateText, streamText } from './core/runtime'

// ==================== Embedding 绫诲瀷 ====================
export type { EmbedManyParams, EmbedManyResult } from './core/runtime'

// ==================== 楂樼骇API ====================
export { isV2Model, isV3Model } from './core/models'

// ==================== 鎻掍欢绯荤粺 ====================
export type {
  AiPlugin,
  AiRequestContext,
  GenerateTextParams,
  GenerateTextResult,
  StreamTextParams,
  StreamTextResult
} from './core/plugins'
export { definePlugin } from './core/plugins'
export { PluginEngine } from './core/runtime/pluginEngine'

// ==================== 绫诲瀷宸ュ叿 ====================
export type {
  AiSdkModel,
  ExtractToolConfig,
  ExtractToolConfigMap,
  ProviderId,
  ToolCapability,
  ToolFactory,
  ToolFactoryMap,
  ToolFactoryPatch,
  WebSearchToolConfigMap
} from './core/providers'

// ==================== 閿欒澶勭悊 ====================
export {
  AiCoreError,
  ModelResolutionError,
  ParameterValidationError,
  PluginExecutionError,
  RecursiveDepthError,
  TemplateLoadError
} from './core/errors'

