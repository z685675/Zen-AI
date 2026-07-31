import type { DeepResearchTaskAction, DeepResearchTaskMetadata, Message } from '@renderer/types/newMessage'

export const DEEP_RESEARCH_REASONING_EFFORT = 'high' as const

export function getAgentSessionDeepResearchCacheKey(agentId: string, sessionId: string): string {
  return `agent-deep-research:${encodeURIComponent(agentId)}:${encodeURIComponent(sessionId)}`
}

export function isDeepResearchTaskMessage(message?: Pick<Message, 'providerMetadata'>): boolean {
  return message?.providerMetadata?.deepResearch?.version === 1
}

export function isDeepResearchTaskRootMessage(message?: Pick<Message, 'id' | 'providerMetadata'>): boolean {
  const metadata = message?.providerMetadata?.deepResearch
  return metadata?.version === 1 && metadata.taskId === message?.id
}

export function getDeepResearchTaskAction(
  message?: Pick<Message, 'id' | 'providerMetadata'>
): DeepResearchTaskAction | undefined {
  const metadata = message?.providerMetadata?.deepResearch
  if (metadata?.version !== 1) {
    return undefined
  }

  return metadata.action ?? (metadata.taskId === message?.id ? 'plan' : undefined)
}

export function shouldStartDeepResearchImmediately(content: string): boolean {
  const normalized = content.trim().toLowerCase()
  return [
    /直接开始/,
    /立即开始/,
    /马上开始/,
    /直接研究/,
    /不用确认/,
    /无需确认/,
    /跳过确认/,
    /\bstart immediately\b/,
    /\bskip (?:the )?confirmation\b/,
    /\bno (?:need for )?confirmation\b/
  ].some((pattern) => pattern.test(normalized))
}

export function classifyDeepResearchFollowUp(content: string): DeepResearchTaskAction | undefined {
  const normalized = content.trim().toLowerCase()
  if (!normalized) {
    return undefined
  }

  const revisionPatterns = [
    /修改/,
    /调整/,
    /补充/,
    /增加/,
    /加入/,
    /删除/,
    /去掉/,
    /缩小/,
    /扩大/,
    /聚焦/,
    /重点/,
    /范围/,
    /改成/,
    /改为/,
    /换成/,
    /只看/,
    /围绕/,
    /先别/,
    /不要/,
    /\brevise\b/,
    /\badjust\b/,
    /\bchange\b/,
    /\badd\b/,
    /\bremove\b/,
    /\bfocus\b/,
    /\bscope\b/
  ]
  if (revisionPatterns.some((pattern) => pattern.test(normalized))) {
    return shouldStartDeepResearchImmediately(normalized) ? 'start' : 'revise'
  }

  const startPatterns = [
    /^(好|好的|可以|确认|同意|通过|没问题|就这样)(了|的|吧|，|,|。|\s)*$/,
    /^(开始|继续|执行|重试|直接做|按计划执行|按这个计划|就按这个方案)/,
    /^(yes|ok|okay|sure|confirmed|approved)[.! ]*$/,
    /\b(go ahead|proceed|start|continue|approved|confirmed|retry)\b/
  ]
  return startPatterns.some((pattern) => pattern.test(normalized)) ? 'start' : undefined
}

export function findResumableDeepResearchTask(
  messages: Array<Pick<Message, 'providerMetadata'>>
): DeepResearchTaskMetadata | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = messages[index]?.providerMetadata?.deepResearch
    if (metadata?.version !== 1 || !metadata.status) {
      continue
    }

    if (metadata.status === 'completed') {
      return undefined
    }

    return metadata
  }

  return undefined
}
