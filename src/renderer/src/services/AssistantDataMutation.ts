import i18n from '@renderer/i18n'

/** Main-process lease spans both filesystem and renderer database mutations. */
export async function runAssistantDataMutation<T>(
  kind: 'restore' | 'reset',
  work: () => Promise<T>
): Promise<T | undefined> {
  const admission = await window.api.backup.beginDataOperation(kind)
  if (!admission.success) {
    window.toast.info(i18n.t('assistantDataSafety.busy'))
    return
  }
  let committed = false
  try {
    const result = await work()
    committed = true
    return result
  } finally {
    await window.api.backup.endDataOperation(admission.token, committed)
  }
}
