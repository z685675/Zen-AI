import type { ImageCanvasTask } from '@shared/config/imageCanvas'
import { useTranslation } from 'react-i18next'

export const downloadSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`

export function DownloadProgress({ task }: { task: ImageCanvasTask }) {
  const { t } = useTranslation()
  if (task.phase !== 'downloading' && task.error !== 'studio_download_failed') return null
  return (
    <div className="image-downloads">
      {task.diagnostics?.downloads?.map((download) => (
        <div className="image-download" key={download.assetId}>
          <div>
            <strong>{t('downloadImage', { index: download.index, count: download.count })}</strong>
            <span>{t('downloadStates.' + download.state, { attempt: download.attempt })}</span>
          </div>
          <progress
            aria-label={t('downloadProgressLabel', { index: download.index })}
            max={download.totalBytes || undefined}
            value={download.totalBytes ? Math.min(download.receivedBytes, download.totalBytes) : undefined}
          />
          <div className="muted">
            <span>
              {downloadSize(download.receivedBytes)}
              {download.totalBytes ? ` / ${downloadSize(download.totalBytes)}` : ` · ${t('downloadUnknownSize')}`}
            </span>
            {download.state === 'downloading' && download.bytesPerSecond > 0 && (
              <span>{downloadSize(download.bytesPerSecond)}/s</span>
            )}
          </div>
          {download.state === 'paused' && <p>{t('downloadResumeHint')}</p>}
        </div>
      ))}
    </div>
  )
}
