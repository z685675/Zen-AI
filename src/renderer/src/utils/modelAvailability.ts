import { chatModelFilter } from '@renderer/config/models'
import type { Model, Provider } from '@renderer/types'

export const getAvailableChatModels = (providers: Provider[]): Model[] =>
  providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) => provider.models ?? [])
    .filter(chatModelFilter)

export const isModelAvailable = (model: Model | undefined, providers: Provider[]): boolean => {
  if (!model) return false

  return getAvailableChatModels(providers).some(
    (candidate) => candidate.id === model.id && candidate.provider === model.provider
  )
}
