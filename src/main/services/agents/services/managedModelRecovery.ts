import { configManager } from '@main/services/ConfigManager'
import { getCachedModelAvailability } from '@main/services/ModelAvailabilityService'
import { remoteModelPolicyService } from '@main/services/RemoteModelPolicyService'
import {
  isTextFallbackIdentifier,
  type ModelRecoveryIntent,
  selectRecoverableModel
} from '@shared/config/modelRecovery'
import { isZenManagedApiHost } from '@shared/config/zenProvider'
import type { ApiModel, Provider } from '@types'

import { isAssistantModelAllowed } from '../../../../renderer/src/config/agentModelPolicy'

const KEY = 'managedSessionModelRecoveryIntents'

function readIntents(): Record<string, ModelRecoveryIntent> {
  const value = configManager.get<Record<string, ModelRecoveryIntent>>(KEY, {})
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, intent]) =>
        intent && typeof intent.preferred === 'string' && (intent.actual === null || typeof intent.actual === 'string')
    )
  )
}

export function forgetSessionModelIntent(sessionId: string): void {
  const records = readIntents()
  delete records[sessionId]
  configManager.set(KEY, records)
}

// Read-only UI projection. Do not discover models, probe or reconcile here.
export function getSessionModelRecoveryIntent(sessionId: string): ModelRecoveryIntent | undefined {
  return readIntents()[sessionId]
}

export async function getManagedRecoveryInventory() {
  // Keep model discovery/window IPC outside the pure selection module's
  // initialization. It is needed only when reconciling/admitting a task.
  const [{ modelsService }, { getAvailableProviders }] = await Promise.all([
    import('@main/apiServer/services/models'),
    import('@main/apiServer/utils')
  ])
  const { data } = await modelsService.getModels({}, true)
  return { models: data, providers: await getAvailableProviders() }
}

export function rememberPreferredModel(slot: string, preferred: string, actual: string | null): void {
  const records = readIntents()
  records[slot] = { preferred, actual }
  configManager.set(KEY, records)
}

export function inheritModelPreference(slot: string, source: string, actual: string): void {
  const intent = readIntents()[source]
  if (intent?.actual === actual) rememberPreferredModel(slot, intent.preferred, actual)
}

export const getPreferredModelIdentifier = (slot: string, current: string): string =>
  readIntents()[slot]?.preferred || current

export function resolveManagedSessionModel(
  slot: string,
  current: string | undefined,
  inventory: { models: ApiModel[]; providers: Provider[] },
  persist = true
): { managed: boolean; selected?: string } {
  const records = readIntents()
  const intent = records[slot]
  const providerId = (current || intent?.preferred)?.split(':')[0]
  const provider = inventory.providers.find((provider) => provider.id === providerId)
  if (!provider || !isZenManagedApiHost(provider.apiHost) || !getCachedModelAvailability(provider))
    return { managed: false, selected: current }
  const policy = remoteModelPolicyService.getSnapshot().policy
  const allowed = inventory.models.filter(
    (model) =>
      model.provider === providerId &&
      model.endpoint_type !== 'image-generation' &&
      model.endpoint_type !== 'jina-rerank' &&
      isTextFallbackIdentifier(model.provider_model_id || model.id) &&
      isAssistantModelAllowed(model, configManager.getEnableDeveloperMode(), policy)
  )
  const result = selectRecoverableModel({
    current,
    intent,
    available: allowed.map((model) => model.id),
    fallbacks: policy.assistant.fallbackModels.filter(isTextFallbackIdentifier).map((id) => `${providerId}:${id}`),
    now: Date.now()
  })
  if (persist && result.intent && JSON.stringify(intent) !== JSON.stringify(result.intent)) {
    records[slot] = result.intent
    configManager.set(KEY, records)
  }
  return { managed: true, selected: result.selected || undefined }
}
