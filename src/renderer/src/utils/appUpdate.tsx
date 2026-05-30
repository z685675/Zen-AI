import { type CSSProperties } from 'react'
import { isMac } from '@renderer/config/constant'
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

const manualInstallNoticeStyle: CSSProperties = {
  padding: '12px 14px',
  borderRadius: 10,
  border: '1px solid rgba(250, 173, 20, 0.28)',
  background: 'rgba(250, 173, 20, 0.1)',
  color: 'var(--color-text)',
  lineHeight: 1.7
}

const installStatusStyle: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid rgba(22, 119, 255, 0.25)',
  background: 'rgba(22, 119, 255, 0.08)',
  color: 'var(--color-text)',
  fontWeight: 500
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

  const renderDownloadedContent = (statusText?: string) => (
    <div style={updateContainerStyle}>
      {statusText && <div style={installStatusStyle}>{statusText}</div>}
      {shouldUseManualMacInstall && (
        <div style={manualInstallNoticeStyle}>
          macOS 当前采用手动安装更新。点击“打开安装包”后，会自动打开已下载的 DMG 安装窗口，请在窗口中将 Zen AI 拖入
          Applications 覆盖安装。
        </div>
      )}
      {renderUpdateContent(t, updateInfo, 'update.message')}
    </div>
  )

  const modal = window.modal.confirm({
    title: t('update.title'),
    okText: shouldUseManualMacInstall ? '打开安装包' : t('update.installNow'),
    cancelText: t('update.later'),
    centered: true,
    width: 720,
    maskClosable: false,
    content: renderDownloadedContent(),
    async onOk() {
      const statusText = shouldUseManualMacInstall ? '正在打开安装程序…' : '正在准备安装包…'
      const restoreModal = () => {
        modal?.update({
          okText: shouldUseManualMacInstall ? '打开安装包' : t('update.installNow'),
          okButtonProps: { loading: false, disabled: false },
          cancelButtonProps: { disabled: false },
          content: renderDownloadedContent()
        })
      }

      modal?.update({
        okText: statusText,
        okButtonProps: { loading: true, disabled: true },
        cancelButtonProps: { disabled: true },
        content: renderDownloadedContent(statusText)
      })
      window.toast.info?.(statusText)

      if (shouldUseManualMacInstall) {
        const result = await window.api.openDownloadedInstaller()
        if (result === true || result?.success === true) {
          const message = result?.fallbackToFolder
            ? '没能直接打开安装包，已为你定位到安装包位置，请双击 DMG 完成安装。'
            : '已打开安装程序，请在安装窗口中拖入 Applications 完成安装。'
          window.toast.info(message)
          return
        }

        const message =
          typeof result?.message === 'string' && result.message
            ? result.message
            : '安装包暂时没有准备好，请重新检查更新，或等待下载完成后再试。'
        window.toast.error(message)
        restoreModal()
        throw new Error(message)
      }

      const result = await window.api.quitAndInstallUpdate()
      if (result === true || result?.success === true) {
        return
      }

      const message =
        typeof result?.message === 'string' && result.message
          ? result.message
          : '更新安装包尚未准备好，请重新检查更新，或等待下载完成后再安装。'
      window.toast.error(message)
      restoreModal()
      throw new Error(message)
    }
  })
}
