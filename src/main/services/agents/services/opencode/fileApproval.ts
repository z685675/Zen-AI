import { t } from '@main/utils/locales'
import { dialog } from 'electron'

import { windowService } from '../../../WindowService'

/** MCP requests do not carry the native tool-call ID. Never create an invisible tool-card approval. */
export async function confirmAssistantFileOverwrite(file: string, taskSignal: AbortSignal) {
  if (taskSignal.aborted) return false
  const window = windowService.getMainWindow()
  if (!window || window.isDestroyed()) return false
  // Keep this bounded below the product MCP timeout; cancellation also closes the macOS parented sheet.
  const signal = AbortSignal.any([taskSignal, AbortSignal.timeout(90_000)])
  try {
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      title: t('assistantFileSafety.title'),
      message: t('assistantFileSafety.message'),
      detail: file,
      buttons: [t('common.cancel'), t('common.confirm')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      signal
    })
    return !signal.aborted && response === 1
  } catch {
    return false
  }
}
