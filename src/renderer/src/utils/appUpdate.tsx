import { type CSSProperties } from 'react'
import { isMac } from '@renderer/config/constant'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'

type Translate = (key: string, options?: Record<string, unknown>) => string

const MAC_MANUAL_DOWNLOAD_URL = 'https://github.com/z685675/Zen-AI/releases/latest'

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

const manualInstallNoticeStyle: CSSProperties = {
  padding: '12px 14px',
  borderRadius: 10,
  border: '1px solid rgba(250, 173, 20, 0.28)',
  background: 'rgba(250, 173, 20, 0.1)',
  color: 'var(--color-text)',
  lineHeight: 1.7
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
    async onOk() {
      const result = await window.api.downloadUpdate()
      if (result?.status === 'error') {
        const message =
          typeof result.message === 'string' && result.message
            ? result.message
            : 'Update download failed. Please check your network and try again.'
        window.toast.error(message)
        throw new Error(message)
      }
    }
  })
}

export function showAppUpdateDownloadedModal(t: Translate, updateInfo: UpdateInfo) {
  const shouldUseManualMacInstall = isMac

  window.modal.confirm({
    title: t('update.title'),
    okText: shouldUseManualMacInstall ? '打开下载页面' : t('update.installNow'),
    cancelText: t('update.later'),
    centered: true,
    width: 720,
    maskClosable: false,
    content: (
      <div style={updateContainerStyle}>
        {shouldUseManualMacInstall && (
          <div style={manualInstallNoticeStyle}>
            macOS 当前版本暂不支持可靠的一键安装。请点击“打开下载页面”，下载最新的 macOS DMG 安装包后手动安装。
          </div>
        )}
        {renderUpdateContent(t, updateInfo, 'update.message')}
      </div>
    ),
    async onOk() {
      if (shouldUseManualMacInstall) {
        await window.api.shell.openExternal(MAC_MANUAL_DOWNLOAD_URL)
        window.toast.info('已打开下载页面，请下载 macOS DMG 安装包后手动安装。')
        return
      }

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
