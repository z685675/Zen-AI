import type { Assistant, Model, Topic } from '@renderer/types'

export function isSameModel(left: Model | undefined, right: Model | undefined): boolean {
  return left?.id === right?.id && left?.provider === right?.provider
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
