import type { Options } from '@anthropic-ai/claude-agent-sdk'

import type { AgentThinkingOptions } from '../../interfaces/AgentStreamInterface'

export function mapClaudeThinkingEffort(effort?: AgentThinkingOptions['effort']): Options['effort'] | undefined {
  switch (effort) {
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
      return effort
    case 'minimal':
      return 'low'
    case 'xhigh':
      return 'max'
    default:
      return undefined
  }
}

export function buildClaudeThinkingOptions(params: {
  thinkingOptions?: AgentThinkingOptions
  useProtocolBridge: boolean
  modelId: string
}): Pick<Options, 'thinking' | 'effort'> {
  const mappedEffort = mapClaudeThinkingEffort(params.thinkingOptions?.effort)
  const isClaudeModel = params.modelId.toLowerCase().includes('claude')
  const needsAdaptiveThinking = Boolean(mappedEffort) && (params.useProtocolBridge || !isClaudeModel)
  const thinking = needsAdaptiveThinking ? ({ type: 'adaptive' } as const) : params.thinkingOptions?.thinking

  return {
    ...(thinking ? { thinking } : {}),
    ...(thinking?.type === 'adaptive' && mappedEffort ? { effort: mappedEffort } : {})
  }
}
