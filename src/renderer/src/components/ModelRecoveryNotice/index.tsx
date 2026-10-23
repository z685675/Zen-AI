import { loggerService } from '@logger'
import { modelRecoveryIntents } from '@renderer/services/modelRecoveryIntents'
import { useAppSelector } from '@renderer/store'
import { MODEL_RECOVERY_STABILITY_MS, type ModelRecoveryIntent } from '@shared/config/modelRecovery'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('ModelRecoveryNotice')

export function ModelRecoveryNotice({ intent }: { intent?: ModelRecoveryIntent }) {
  const { t } = useTranslation()
  const providers = useAppSelector((state) => state.llm.providers)
  const [now, setNow] = useState(Date.now)
  const visible = !!intent && intent.preferred !== intent.actual
  useEffect(() => {
    if (!visible) return
    const timer = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(timer)
  }, [visible])
  if (!visible || !intent) return null
  const name = (id: string) => {
    const separator = id.indexOf(':')
    const provider = providers.find((provider) => provider.id === id.slice(0, separator))
    return provider?.models.find((model) => model.id === id.slice(separator + 1))?.name || id.slice(separator + 1)
  }
  const delay = Math.max(
    MODEL_RECOVERY_STABILITY_MS,
    Number.isFinite(intent.recoveryDelayMs) ? intent.recoveryDelayMs! : 0
  )
  const remaining = Number.isFinite(intent.recoveredAt) ? Math.max(0, intent.recoveredAt! + delay - now) : undefined
  let detail = t('model_recovery.unavailable')
  if (remaining !== undefined) {
    detail =
      remaining > 0
        ? t('model_recovery.observing', { minutes: Math.ceil(remaining / 60000) })
        : t('model_recovery.idle')
  }
  return (
    <div role="status" className="px-4 py-1 text-[var(--color-text-3)] text-xs">
      {intent.actual
        ? t('model_recovery.fallback', { preferred: name(intent.preferred), actual: name(intent.actual) })
        : t('model_recovery.empty', { preferred: name(intent.preferred) })}{' '}
      {detail}
    </div>
  )
}

export function TopicModelRecoveryNotice({ topicId }: { topicId: string }) {
  const intent = useSyncExternalStore(modelRecoveryIntents.subscribe, () =>
    modelRecoveryIntents.get(`topic:${topicId}`)
  )
  return <ModelRecoveryNotice intent={intent} />
}

export function SessionModelRecoveryNotice({
  agentId,
  sessionId,
  model
}: {
  agentId: string
  sessionId: string
  model?: string
}) {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; intent?: ModelRecoveryIntent }>()
  useEffect(() => {
    let cancelled = false
    let pending = false
    const refresh = async () => {
      if (pending || document.hidden) return
      pending = true
      try {
        const intent = await window.api.modelPolicy.recoveryStatus(agentId, sessionId)
        if (!cancelled) setSnapshot({ sessionId, intent })
      } catch (error) {
        if (!cancelled) setSnapshot(undefined)
        logger.debug('Could not read optional recovery status', error as Error)
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 15000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [agentId, sessionId, model])
  const intent =
    snapshot?.sessionId === sessionId && (snapshot.intent?.actual || '') === (model || '') ? snapshot.intent : undefined
  return <ModelRecoveryNotice intent={intent} />
}
