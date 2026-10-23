import { modelRecoveryIntents } from '@renderer/services/modelRecoveryIntents'
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
    if (!defaultModel && modelRecoveryIntents.get('global:chat')?.actual === null) return undefined
    return defaultModel ?? assistant.defaultModel ?? assistant.model
  }

  if (!assistant.defaultModel && modelRecoveryIntents.get(`assistant:${assistant.id}:defaultModel`)?.actual === null)
    return undefined
  return getAssistantConversationModel({ ...assistant, model: assistant.defaultModel ?? assistant.model }, defaultModel)
}

export function getAssistantConversationModel(assistant: Assistant, defaultModel?: Model): Model | undefined {
  if (!assistant.model && modelRecoveryIntents.get(`assistant:${assistant.id}:model`)?.actual === null) return undefined
  if (
    !assistant.model &&
    !assistant.defaultModel &&
    modelRecoveryIntents.get(`assistant:${assistant.id}:defaultModel`)?.actual === null
  )
    return undefined
  return assistant.model ?? assistant.defaultModel ?? defaultModel
}

export function getTopicConversationModel(topic: Topic, assistant: Assistant, defaultModel?: Model): Model | undefined {
  if (!topic.model && modelRecoveryIntents.get(`topic:${topic.id}`)?.actual === null) return undefined
  return topic.model ?? getAssistantConversationModel(assistant, defaultModel)
}

export function getTopicConversationAssistant(topic: Topic, assistant: Assistant, defaultModel?: Model): Assistant {
  return {
    ...assistant,
    model: getTopicConversationModel(topic, assistant, defaultModel),
    enableWebSearch: false,
    webSearchProviderId: topic.enableWebSearch ? TOPIC_WEB_SEARCH_PROVIDER_ID : undefined
  }
}
