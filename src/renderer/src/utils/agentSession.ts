import type { AgentConfiguration, AgentRuntime, AgentType, ApiModel, ApiModelsFilter } from '@renderer/types'

const SESSION_TOPIC_PREFIX = 'agent-session:'

export const buildAgentSessionTopicId = (sessionId: string): string => {
  return `${SESSION_TOPIC_PREFIX}${sessionId}`
}

export const isAgentSessionTopicId = (topicId: string): boolean => {
  return topicId.startsWith(SESSION_TOPIC_PREFIX)
}

export const extractAgentSessionIdFromTopicId = (topicId: string): string => {
  return topicId.replace(SESSION_TOPIC_PREFIX, '')
}

import discordIcon from '@renderer/assets/images/channel/discord.svg'
import feishuIcon from '@renderer/assets/images/channel/feishu.jpeg'
import qqIcon from '@renderer/assets/images/channel/qq.svg'
import slackIcon from '@renderer/assets/images/channel/slack.svg'
import telegramIcon from '@renderer/assets/images/channel/telegram.png'
import wechatIcon from '@renderer/assets/images/channel/wechat.png'

const CHANNEL_TYPE_ICONS: Record<string, string> = {
  telegram: telegramIcon,
  feishu: feishuIcon,
  qq: qqIcon,
  wechat: wechatIcon,
  discord: discordIcon,
  slack: slackIcon
}

export const getChannelTypeIcon = (channelType: string | undefined): string | undefined => {
  if (!channelType) return undefined
  return CHANNEL_TYPE_ICONS[channelType]
}

type RuntimeCompatibleApiModel = Pick<
  ApiModel,
  'provider_type' | 'endpoint_type' | 'supported_endpoint_types' | 'agent_runtime_compatibility'
>

export const isApiModelCompatibleWithAgentRuntime = (
  model: RuntimeCompatibleApiModel,
  runtime: AgentRuntime
): boolean => {
  if (runtime === 'auto') {
    return true
  }

  if (model.agent_runtime_compatibility) {
    return model.agent_runtime_compatibility.includes(runtime)
  }

  // Missing capability metadata means unverified, not unsupported. Manual
  // developer overrides may still attempt the runtime and report the real error.
  return true
}

export const getModelFilterByAgentType = (type: AgentType, configuration?: AgentConfiguration): ApiModelsFilter => {
  if (configuration?.agent_runtime === 'codex') {
    return {}
  }

  if (configuration?.agent_runtime === 'claude-code') {
    // Mixed gateways can expose Anthropic-compatible endpoints without using
    // provider_type=anthropic, so the popup performs endpoint-aware filtering.
    return {}
  }

  switch (type) {
    case 'claude-code':
      return {}
    default:
      return {}
  }
}
