import type { ErrorDiagnosticPackageInput } from '@renderer/services/ErrorDiagnosticPackageService'
import { exportErrorDiagnosticPackage, getDiagnosticAppInfo } from '@renderer/services/ErrorDiagnosticPackageService'
import { Checkbox } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type TurnExportInput = Pick<
  ErrorDiagnosticPackageInput,
  | 'source'
  | 'message'
  | 'relatedUserMessage'
  | 'blockEntities'
  | 'sessionContext'
  | 'sessionContextStatus'
  | 'snapshotHasMessage'
>

/** Shared by the chosen response menu and the current-session snapshot menu. */
export function useTurnDiagnosticExport() {
  const { t } = useTranslation()
  const [exporting, setExporting] = useState(false)
  const locked = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const exportTurn = useCallback(
    (input: TurnExportInput) => {
      if (locked.current) return
      locked.current = true
      let includeContent = false
      // Capture only this turn. Redux entities are immutable; later navigation,
      // messages or another task must not replace the user's selected response.
      const ids = [...input.message.blocks, ...(input.relatedUserMessage?.blocks ?? [])]
      const snapshot = {
        ...input,
        blockEntities: Object.fromEntries(ids.map((id) => [id, input.blockEntities?.[id]]))
      }
      const unlock = () => {
        locked.current = false
        if (mounted.current) setExporting(false)
      }
      try {
        window.modal.confirm({
          title: t('turnDiagnostics.export'),
          content: (
            <>
              <p>{t('turnDiagnostics.privacy')}</p>
              <Checkbox
                defaultChecked={false}
                onChange={(event) => {
                  includeContent = event.target.checked
                }}>
                {t('turnDiagnostics.includeContent')}
              </Checkbox>
            </>
          ),
          okText: t('turnDiagnostics.export'),
          onCancel: unlock,
          onOk: async () => {
            if (mounted.current) setExporting(true)
            try {
              const saved = await exportErrorDiagnosticPackage({
                ...snapshot,
                title: t('turnDiagnostics.export'),
                description: t('turnDiagnostics.description'),
                privacyNotice: t('turnDiagnostics.privacy'),
                includeContent,
                appInfo: await getDiagnosticAppInfo()
              })
              if (saved) window.toast.success(t('assistantPeripheral.exportSaved'))
            } catch {
              window.toast.error(t('assistantPeripheral.exportFailed'))
            } finally {
              unlock()
            }
          }
        })
      } catch {
        unlock()
      }
    },
    [t]
  )
  return { exportTurn, exporting }
}
