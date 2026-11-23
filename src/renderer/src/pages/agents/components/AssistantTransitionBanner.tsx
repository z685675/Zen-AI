import { useAgentClient } from '@renderer/hooks/agents/useAgentClient'
import { useLegacyContinuation } from '@renderer/hooks/agents/useLegacyContinuation'
import type { GetAgentSessionResponse } from '@renderer/types'
import { getLegacyConversationPath } from '@renderer/utils/legacyConversations'
import { Alert, Button } from 'antd'
import { useTranslation } from 'react-i18next'

export default function AssistantTransitionBanner({
  agentId,
  session,
  welcome = false,
  running = false,
  legacyHistory = false
}: {
  agentId: string
  session?: GetAgentSessionResponse
  welcome?: boolean
  running?: boolean
  legacyHistory?: boolean
}) {
  const { t } = useTranslation()
  const client = useAgentClient()
  const { busy, continueInNew } = useLegacyContinuation(agentId, session?.id ?? '')
  const metadata = session?.configuration?.legacy_continuation as Record<string, unknown> | undefined
  const imported = metadata?.state === 'ready'
  const warnings = Array.isArray(metadata?.attachment_warnings)
    ? metadata.attachment_warnings.filter((item): item is string => typeof item === 'string')
    : []
  const viewSource = async () => {
    if (typeof metadata?.source_agent_id !== 'string' || typeof metadata.source_session_id !== 'string') return
    try {
      await client.getContinuationSource(metadata.source_agent_id, metadata.source_session_id)
      window.navigate(
        getLegacyConversationPath({ agentId: metadata.source_agent_id, sessionId: metadata.source_session_id })
      )
    } catch {
      window.toast.info(t('assistant_transition.source_unavailable'))
    }
  }
  return (
    <Alert
      type="info"
      style={{ margin: '8px 16px', flexShrink: 0 }}
      message={t(
        imported
          ? 'assistant_transition.snapshot'
          : legacyHistory
            ? 'assistant_transition.legacy_history_read_only'
            : 'assistant_transition.legacy_read_only'
      )}
      description={
        imported ? (
          <>
            <div>{t('assistant_transition.snapshot_description')}</div>
            {metadata?.model_changed === true && <div>{t('assistant_transition.model_changed')}</div>}
            {warnings.length > 0 && (
              <div>{t('assistant_transition.attachments_unavailable', { files: warnings.join('、') })}</div>
            )}
          </>
        ) : legacyHistory ? undefined : (
          t('assistant_transition.legacy_automation_disabled')
        )
      }
      action={
        imported ? (
          <Button size="small" onClick={() => void viewSource()}>
            {t('assistant_transition.view_source')}
          </Button>
        ) : welcome ? (
          <Button size="small" onClick={() => window.navigate('/new-assistant')}>
            {t('assistant_transition.open_new')}
          </Button>
        ) : (
          <Button size="small" loading={busy} disabled={running || !session} onClick={continueInNew}>
            {t('assistant_transition.continue')}
          </Button>
        )
      }
    />
  )
}
