import { type CSSProperties } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'

type Translate = (key: string, options?: Record<string, unknown>) => string

export interface UpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
}

export function formatReleaseDate(value?: string) {
  if (!value) {
    return undefined
  }

  const normalized = typeof value === 'string' ? value : String(value)
  const date = new Date(normalized)

  if (Number.isNaN(date.getTime())) {
    return normalized
  }

  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

const updateContainerStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
  lineHeight: 1.6
}

const releaseNotesStyle: CSSProperties = {
  maxHeight: 420,
  overflowY: 'auto',
  padding: '12px 14px',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  background: 'var(--color-background-soft)'
}

function renderReleaseNotes(releaseNotes: string) {
  return (
    <div className="markdown" style={releaseNotesStyle}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]} rehypePlugins={[rehypeRaw]}>
        {releaseNotes}
      </ReactMarkdown>
    </div>
  )
}

function renderUpdateContent(t: Translate, updateInfo: UpdateInfo, messageKey: string) {
  const releaseDate = formatReleaseDate(updateInfo.releaseDate)
  const releaseNotes = updateInfo.releaseNotes?.trim() || t('update.noReleaseNotes')

  return (
    <div style={updateContainerStyle}>
      <div style={{ fontWeight: 500 }}>{t(messageKey, { version: updateInfo.version })}</div>
      <div>
        <strong>{t('update.version')}:</strong> {updateInfo.version}
      </div>
      {releaseDate && (
        <div>
          <strong>{t('update.releaseDate')}:</strong> {releaseDate}
        </div>
      )}
      {renderReleaseNotes(releaseNotes)}
    </div>
  )
}

export function showAppUpdateDownloadingToast(t: Translate, version: string) {
  window.toast.info(t('update.downloading', { version }))
}

export function showAppUpdateAvailableModal(t: Translate, updateInfo: UpdateInfo) {
  window.modal.confirm({
    title: t('update.title'),
    okText: t('update.downloadNow'),
    cancelText: t('update.later'),
    centered: true,
    width: 720,
    maskClosable: false,
    content: renderUpdateContent(t, updateInfo, 'update.available'),
    onOk() {
      return window.api.downloadUpdate()
    }
  })
}

export function showAppUpdateDownloadedModal(t: Translate, updateInfo: UpdateInfo) {
  window.modal.confirm({
    title: t('update.title'),
    okText: t('update.installNow'),
    cancelText: t('update.later'),
    centered: true,
    width: 720,
    maskClosable: false,
    content: renderUpdateContent(t, updateInfo, 'update.message'),
    async onOk() {
      const result = await window.api.quitAndInstallUpdate()
      if (result === true || result?.success === true) {
        return
      }

      const message =
        typeof result?.message === 'string' && result.message
          ? result.message
          : '更新安装包尚未准备好，请重新检查更新或等待下载完成后再安装。'
      window.toast.error(message)
      throw new Error(message)
    }
  })
}
