import type { Model } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'

type RetryModelSelection = Pick<Message, 'model' | 'modelId'>

type ResolveRetryModelSelectionOptions = {
  conversationModel?: Model
  originalAssistantMessage: Pick<Message, 'model' | 'modelId'>
  preserveOriginalModel: boolean
}

export const resolveRetryModelSelection = ({
  conversationModel,
  originalAssistantMessage,
  preserveOriginalModel
}: ResolveRetryModelSelectionOptions): RetryModelSelection => {
  if (preserveOriginalModel) {
    return {
      model: originalAssistantMessage.model,
      modelId: originalAssistantMessage.modelId
    }
  }

  return {
    model: conversationModel ?? originalAssistantMessage.model,
    modelId: undefined
  }
}
