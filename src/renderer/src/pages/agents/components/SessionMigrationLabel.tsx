import type { AgentSessionEntity } from '@renderer/types'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { useTranslation } from 'react-i18next'

export default function SessionMigrationLabel({
  session
}: {
  session: Pick<AgentSessionEntity, 'agent_id' | 'configuration'>
}) {
  const { t } = useTranslation()
  const metadata = session.configuration?.legacy_continuation as Record<string, unknown> | undefined
  if (
    session.agent_id !== DEFAULT_OPENCODE_AGENT_ID ||
    metadata?.state !== 'ready' ||
    typeof metadata.source_agent_id !== 'string' ||
    !metadata.source_agent_id ||
    typeof metadata.source_session_id !== 'string' ||
    !metadata.source_session_id
  ) {
    return null
  }

  return (
    <div className="mt-1 text-(--color-text-3) text-[10px] leading-[14px]">
      {t('assistant_transition.migrated_conversation')}
    </div>
  )
}
