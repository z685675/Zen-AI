import i18next from 'i18next'

import type { ClientErrorDiagnosis } from './clientErrorDiagnosis'

/** Keep user-facing recovery guidance separate from the diagnosis retained in exports and details. */
export function getClientErrorPresentation(diagnosis: ClientErrorDiagnosis, source: 'chat' | 'agent') {
  const interrupted =
    diagnosis.category === 'cancelled' ||
    [
      'agent_permission_denied',
      'agent_execution_timeout',
      'agent_inactivity_timeout',
      'agent_human_wait_timeout'
    ].includes(diagnosis.errorType)

  if (interrupted) {
    return { title: diagnosis.title, description: diagnosis.summary }
  }

  return {
    title: i18next.t(source === 'agent' ? 'error.fallback.task_title' : 'error.fallback.reply_title'),
    description: i18next.t('error.fallback.description'),
    resultNotice: source === 'agent' ? i18next.t('error.fallback.check_results') : undefined
  }
}
