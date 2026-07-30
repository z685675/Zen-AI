import type { Model } from '@renderer/types'
import { getLowerBaseModelName } from '@renderer/utils/naming'

export const CURRENT_DEFAULT_MODEL_ID = 'gpt-5.6-luna'

export interface CurrentDefaultModels {
  defaultModel?: Model
  quickModel?: Model
  translateModel?: Model
}

export function getCurrentDefaultModels(models: Model[]): CurrentDefaultModels {
  const model = models.find((candidate) => getLowerBaseModelName(candidate.id.trim()) === CURRENT_DEFAULT_MODEL_ID)

  return {
    defaultModel: model,
    quickModel: model,
    translateModel: model
  }
}
