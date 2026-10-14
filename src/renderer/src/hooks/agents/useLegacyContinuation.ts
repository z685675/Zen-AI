import { loggerService } from '@logger'
import { useAppDispatch } from '@renderer/store'
import { setActiveAgentId, setActiveSessionIdAction } from '@renderer/store/runtime'
import { markAgentEntrySelection } from '@renderer/utils/agentEntrySelection'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { isAxiosError } from 'axios'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAgentClient } from './useAgentClient'

const logger = loggerService.withContext('LegacyContinuation')
const errors = new Set([
  'continuation_busy',
  'continuation_source_missing',
  'continuation_empty',
  'continuation_workspace_missing',
  'continuation_no_model',
  'continuation_too_large',
  'continuation_invalid_history',
  'continuation_source_changed'
])

export function useLegacyContinuation(agentId: string, sessionId: string) {
  const client = useAgentClient()
  const dispatch = useAppDispatch()
  const { t } = useTranslation()
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const continueInNew = useCallback(() => {
    if (inFlight.current) return
    inFlight.current = true
    window.modal.confirm({
      title: t('assistant_transition.confirm_title'),
      content: t('assistant_transition.confirm_content'),
      centered: true,
      okText: t('assistant_transition.continue'),
      onCancel: () => {
        inFlight.current = false
      },
      onOk: async () => {
        setBusy(true)
        try {
          const result = await client.continueInNewAssistant(agentId, sessionId)
          markAgentEntrySelection('opencode', { agentId: DEFAULT_OPENCODE_AGENT_ID, sessionId: result.session.id })
          dispatch(setActiveAgentId(DEFAULT_OPENCODE_AGENT_ID))
          dispatch(setActiveSessionIdAction({ agentId: DEFAULT_OPENCODE_AGENT_ID, sessionId: result.session.id }))
          window.navigate('/new-assistant')
          window.toast.success(t(result.reused ? 'assistant_transition.reused' : 'assistant_transition.success'))
        } catch (error) {
          const code = isAxiosError(error) ? error.response?.data?.error?.code : undefined
          const errorKey = `assistant_transition.${errors.has(code) ? code : 'continuation_prepare_failed'}`
          window.toast.error(t(errorKey))
          logger.warn('Continuation failed; original session retained', error as Error)
        } finally {
          inFlight.current = false
          setBusy(false)
        }
      }
    })
  }, [agentId, client, dispatch, sessionId, t])
  return { busy, continueInNew }
}
