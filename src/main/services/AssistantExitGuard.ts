import { t } from '@main/utils/locales'
import { dialog } from 'electron'

import { hasActiveOpenCodeTask } from './agents/services/opencode/process'
import { activeSessionTaskCount } from './agents/services/sessionActivity'

/** A cancelled quit must not stop children or put the runtime into shutdown mode. */
export function createAssistantExitGuard(isBusy: () => boolean, confirm: () => Promise<boolean> | boolean) {
  let pending: Promise<boolean> | undefined
  return () => {
    if (pending) return pending
    if (!isBusy()) return Promise.resolve(true)
    pending = Promise.resolve()
      .then(confirm)
      .catch(() => false)
      .finally(() => {
        pending = undefined
      })
    return pending
  }
}

export const hasAssistantTasks = () => activeSessionTaskCount() > 0 || hasActiveOpenCodeTask()
export const allowAssistantExit = createAssistantExitGuard(
  hasAssistantTasks,
  async () =>
    (
      await dialog.showMessageBox({
        type: 'warning',
        title: t('assistantPeripheral.quitTitle'),
        message: t('assistantPeripheral.quitMessage'),
        detail: t('assistantPeripheral.quitDetail'),
        buttons: [t('assistantPeripheral.keepRunning'), t('assistantPeripheral.quitAnyway')],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
    ).response === 1
)
