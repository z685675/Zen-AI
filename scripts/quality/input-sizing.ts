import { approximateTokenSize } from 'tokenx'

export type InputSizingPolicy = 'utf8-bytes' | 'estimated-tokens' | 'deep-estimate'

export interface InputSizingEvidence {
  strategy: InputSizingPolicy
  requestBytes: number
  textAndToolsBytes: number
  approximateTokens: number
  safetyMultiplier: number
  imageTokens: number
  overheadTokens: number
  estimatedInputTokens: number
  maxInputTokens: number
}

export function inputSizingPolicy(config: {
  execution?: { inputSizing?: 'utf8-bytes' | 'estimated-tokens' }
  deep?: { acknowledgedApproximateInputSizing: true }
}): InputSizingPolicy {
  return config.deep?.acknowledgedApproximateInputSizing
    ? 'deep-estimate'
    : (config.execution?.inputSizing ?? 'utf8-bytes')
}

export function sizeInput(
  serialized: string,
  options: { strategy: InputSizingPolicy; requestBytes: number; imageTokens: number; maxInputTokens: number }
): InputSizingEvidence {
  const textAndToolsBytes = Buffer.byteLength(serialized)
  const approximateTokens = approximateTokenSize(serialized)
  const safetyMultiplier = options.strategy === 'estimated-tokens' ? 2 : 1
  const overheadTokens = 4096
  const textTokens =
    options.strategy === 'utf8-bytes' ? textAndToolsBytes : Math.ceil(approximateTokens * safetyMultiplier)
  return {
    ...options,
    textAndToolsBytes,
    approximateTokens,
    safetyMultiplier,
    overheadTokens,
    estimatedInputTokens: textTokens + options.imageTokens + overheadTokens
  }
}

export function describeInputSizing(policy: InputSizingPolicy) {
  return policy === 'utf8-bytes'
    ? '输入预检：UTF-8字节保守筛查 + 图像预留 + 4096协议余量；字节数不是实测Token数。'
    : `输入预检：tokenx近似估算${policy === 'estimated-tokens' ? '×2安全余量' : '（已明确确认的深度模式）'} + 图像预留 + 4096协议余量；不是精确Tokenizer或硬费用保证，仍按完整批准额度预留、按实耗结算，超限停止后续请求。`
}
