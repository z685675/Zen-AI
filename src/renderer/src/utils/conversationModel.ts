import type { Assistant, Model, Topic } from '@renderer/types'

export const TOPIC_WEB_SEARCH_PROVIDER_ID = 'auto-free' as const

export function isSameModel(left: Model | undefined, right: Model | undefined): boolean {
  return left?.id === right?.id && left?.provider === right?.provider
}

export function shouldPersistConversationModelAsDefault(hasLoadedMessages: boolean, messageCount: number): boolean {
  return hasLoadedMessages && messageCount === 0
}

export function getNewConversationModel(assistant: Assistant, defaultModel?: Model): Model | undefined {
  if (assistant.id === 'default') {
    return defaultModel ?? assistant.defaultModel ?? assistant.model
  }

  return assistant.defaultModel ?? assistant.model ?? defaultModel
}

export function getTopicConversationModel(topic: Topic, assistant: Assistant, defaultModel?: Model): Model | undefined {
  return topic.model ?? assistant.model ?? assistant.defaultModel ?? defaultModel
}

export function getTopicConversationAssistant(topic: Topic, assistant: Assistant, defaultModel?: Model): Assistant {
  return {
    ...assistant,
    model: getTopicConversationModel(topic, assistant, defaultModel),
    enableWebSearch: false,
    webSearchProviderId: topic.enableWebSearch ? TOPIC_WEB_SEARCH_PROVIDER_ID : undefined
  }
}
