import type { FilePathCheck, FilePathStatus } from '@shared/filePathStatus'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { localArtifactKey } from './artifactShortcuts'

async function checkPaths(paths: string[]): Promise<FilePathCheck[]> {
  const batches: Promise<FilePathCheck[]>[] = []
  for (let offset = 0; offset < paths.length; offset += 200) {
    const batch = paths.slice(offset, offset + 200)
    batches.push(
      Promise.resolve()
        .then(() => window.api.file.checkPaths(batch))
        .catch(() => batch.map((path) => ({ path, status: 'unavailable' as const })))
    )
  }
  return (await Promise.all(batches)).flat()
}

/** Check only registered paths; never scan directories or change persisted history. */
export function useArtifactAvailability(artifacts: { path: string; registrationId?: string }[], enabled = true) {
  const { t } = useTranslation()
  // Recheck a newly registered output even when its path and file size did not change.
  const signature = JSON.stringify(artifacts.map((artifact) => [artifact.path, artifact.registrationId]))
  const generation = useRef(0)
  const [checked, setChecked] = useState<{ signature: string; statuses: Record<string, FilePathStatus> }>({
    signature: '',
    statuses: {}
  })
  const refresh = useCallback(async () => {
    if (!enabled) return
    const request = ++generation.current
    const paths = (JSON.parse(signature) as [string, string | null][]).map(([path]) => path)
    const results = await checkPaths(paths)
    if (request !== generation.current) return
    setChecked({
      signature,
      statuses: Object.fromEntries(results.map((result) => [localArtifactKey(result.path), result.status]))
    })
  }, [signature, enabled])
  const invalidate = useCallback(() => {
    generation.current++
  }, [])

  useEffect(() => {
    void refresh()
    const onFocus = () => void refresh()
    if (enabled) window.addEventListener('focus', onFocus)
    return () => {
      invalidate()
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh, enabled, invalidate])

  const status = (path: string): FilePathStatus | 'checking' =>
    checked.signature === signature ? (checked.statuses[localArtifactKey(path)] ?? 'checking') : 'checking'

  const open = async (path: string, reveal = false) => {
    const [result] = await checkPaths([path])
    setChecked((previous) => ({
      signature,
      statuses: {
        ...(previous.signature === signature ? previous.statuses : {}),
        [localArtifactKey(path)]: result.status
      }
    }))
    if (result.status !== 'available') {
      window.toast.error(
        t(result.status === 'missing' ? 'chat.input.tools.file_not_found' : 'chat.input.tools.open_file_error', {
          path
        })
      )
      return
    }
    try {
      if (reveal) await window.api.file.showInFolder(path)
      else await window.api.file.openPath(path)
    } catch {
      window.toast.error(t('chat.input.tools.open_file_error', { path }))
      void refresh()
    }
  }

  return { status, refresh, open }
}
