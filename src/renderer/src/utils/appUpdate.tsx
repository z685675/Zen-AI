import { isMac } from '@renderer/config/constant'
import type { AppUpdateProgressInfo } from '@renderer/hooks/useAppUpdateState'
import { Progress } from 'antd'
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

type InstallFailureResult = {
  success?: false
  status?: string
  message?: string
  updateInfo?: UpdateInfo | null
  stage?: 'package-missing' | 'prepare-installer' | 'open-installer' | 'start-installer'
  installerPath?: string
}

const LARGE_MODAL_WIDTH = 'min(80vw, calc(100vw - 32px))'

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
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  height: '100%',
  gap: 12,
  lineHeight: 1.6
}

const largeModalBodyStyle: CSSProperties = {
  height: 'min(80vh, 720px)',
  maxHeight: 'calc(100dvh - 48px)',
  overflow: 'hidden'
}

const releaseNotesStyle: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
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

function formatInstallFailureMessage(result: InstallFailureResult | undefined, fallback: string) {
  const message = result?.message || fallback
  const stageText = {
    'package-missing': '安装包尚未准备好',
    'prepare-installer': '准备安装包失败',
    'open-installer': '打开安装程序失败',
    'start-installer': '启动安装程序失败'
  }[result?.stage ?? '']
  const details = [
    stageText ? `阶段：${stageText}` : undefined,
    result?.updateInfo?.version ? `版本：${result.updateInfo.version}` : undefined,
    result?.installerPath ? `安装包：${result.installerPath}` : undefined
  ].filter(Boolean)

  return details.length > 0 ? `${message}\n${details.join('\n')}` : message
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

type PromptPhase = 'available' | 'downloading' | 'downloaded' | 'installing'
type UpdatePrompt = {
  version: string
  ready: (info: UpdateInfo) => void
  downloading: () => void
  close: () => void
}
let activePrompt: UpdatePrompt | undefined

export function closeAppUpdateModal() {
  activePrompt?.close()
}

function showAppUpdateModal(t: Translate, initialInfo: UpdateInfo, initialPhase: PromptPhase) {
  if (activePrompt?.version === initialInfo.version) {
    if (initialPhase === 'downloaded') activePrompt.ready(initialInfo)
    else if (initialPhase === 'downloading') activePrompt.downloading()
    return
  }
  closeAppUpdateModal()
  let info = initialInfo
  let phase = initialPhase
  let progress: AppUpdateProgressInfo | null = null
  let error: string | undefined
  let revision = 0
  let closed = false
  const unsubscribe: Array<() => void> = []
  const close = () => {
    if (closed) return
    closed = true
    for (const remove of unsubscribe) remove()
    if (activePrompt === prompt) activePrompt = undefined
    modal?.destroy()
  }
  const ready = (next: UpdateInfo) => {
    info = next
    if (phase === 'installing') return
    phase = 'downloaded'
    progress = null
    error = undefined
    refresh()
  }
  const prompt: UpdatePrompt = {
    version: info.version,
    ready,
    close,
    downloading: () => {
      if (phase === 'available') {
        phase = 'downloading'
        error = undefined
        refresh()
      }
    }
  }
  activePrompt = prompt
  const content = () => (
    <div style={updateContainerStyle}>
      {(phase === 'downloading' || phase === 'installing') && (
        <div role="status" aria-live="polite" style={installStatusStyle}>
          {t(phase === 'installing' ? 'update.preparingInstall' : 'update.downloadProgress', { version: info.version })}
          {(phase === 'downloading' || progress) && (
            <>
              <Progress
                percent={progress?.total ? Math.min(100, Math.round(progress.percent)) : 0}
                status="active"
                showInfo={Boolean(progress?.total)}
              />
              {progress && (
                <div>
                  {(progress.transferred / 1024 / 1024).toFixed(1)} MB
                  {progress.total > 0 ? ` / ${(progress.total / 1024 / 1024).toFixed(1)} MB` : ''}
                  {progress.bytesPerSecond > 0 ? ` · ${(progress.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s` : ''}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {error && (
        <div role="alert" style={manualInstallNoticeStyle}>
          {error}
        </div>
      )}
      {isMac && phase === 'downloaded' && <div style={manualInstallNoticeStyle}>{t('update.macInstallNotice')}</div>}
      {renderUpdateContent(
        t,
        info,
        phase === 'available' || phase === 'downloading' ? 'update.available' : 'update.message'
      )}
    </div>
  )
  const options = () => ({
    okText:
      phase === 'installing'
        ? t('update.preparingInstall')
        : phase === 'downloading'
          ? t('update.downloadProgress', { version: info.version })
          : phase === 'downloaded'
            ? isMac
              ? t('update.openInstaller')
              : t('update.installNow')
            : t('update.downloadNow'),
    okButtonProps: {
      loading: phase === 'installing' || phase === 'downloading',
      disabled: phase === 'installing' || phase === 'downloading'
    },
    cancelButtonProps: { disabled: phase === 'installing' },
    content: content()
  })
  function refresh() {
    revision++
    if (!closed) modal?.update(options())
  }
  const isDownloaded = () => phase === 'downloaded'
  async function download() {
    if (phase !== 'available' || closed) return
    phase = 'downloading'
    error = undefined
    progress = null
    refresh()
    try {
      const result = await window.api.downloadUpdate()
      if (closed) return
      if (result?.status === 'error') throw new Error(result.message || t('update.downloadFailed'))
      if (result?.status === 'downloaded' && result.updateInfo) ready(result.updateInfo)
      else if (result?.status !== 'downloading' && !isDownloaded()) throw new Error(t('update.downloadFailed'))
    } catch (cause) {
      if (closed) return
      phase = 'available'
      error = cause instanceof Error ? cause.message : t('update.downloadFailed')
      refresh()
    }
  }
  async function install() {
    if (phase !== 'downloaded' || closed) return
    phase = 'installing'
    error = undefined
    refresh()
    try {
      const result = await window.api.quitAndInstallUpdate()
      if (closed) return
      if (result?.status === 'cancelled') {
        phase = 'downloaded'
        refresh()
        return
      }
      if (result === true || result?.success === true) {
        if (isMac) window.toast.info(t(result?.fallbackToFolder ? 'update.installerFolder' : 'update.installerOpened'))
        close()
        return
      }
      throw new Error(formatInstallFailureMessage(result, t('update.installFailed')))
    } catch (cause) {
      if (closed) return
      phase = 'downloaded'
      error = cause instanceof Error ? cause.message : t('update.installFailed')
      refresh()
    }
  }
  const modal = window.modal.confirm({
    title: t('update.title'),
    cancelText: t('update.later'),
    centered: true,
    width: LARGE_MODAL_WIDTH,
    className: 'zen-app-update-modal',
    bodyStyle: largeModalBodyStyle,
    maskClosable: false,
    ...options(),
    // A synchronous callback with the close argument keeps AntD from closing
    // the prompt when a download resolves. The same prompt becomes Install.
    onOk(_close: () => void) {
      void _close
      if (phase === 'available') void download()
      else if (phase === 'downloaded') void install()
    },
    onCancel: close,
    afterClose: close
  })
  unsubscribe.push(
    window.api.update.onDownloadProgress((next) => {
      if (phase !== 'downloading' && phase !== 'installing') return
      progress = next
      refresh()
    }),
    window.api.update.onDownloaded((next) => {
      if (next.version === info.version) ready(next)
    }),
    window.api.update.onError((next) => {
      if (phase !== 'downloading') return
      phase = 'available'
      error = next.message || t('update.downloadFailed')
      refresh()
    })
  )
  const snapshotRevision = revision
  void window.api
    .getUpdateState()
    .then((state) => {
      if (closed || revision !== snapshotRevision || state.updateInfo?.version !== info.version) return
      if (state.status === 'downloaded') ready(state.updateInfo)
      else if (state.status === 'downloading' && phase !== 'installing') {
        phase = 'downloading'
        progress = state.progress
        refresh()
      }
    })
    .catch(() => undefined)
}

export function showAppUpdateAvailableModal(t: Translate, info: UpdateInfo) {
  showAppUpdateModal(t, info, 'available')
}

export function showAppUpdateDownloadedModal(t: Translate, info: UpdateInfo) {
  showAppUpdateModal(t, info, 'downloaded')
}

export function showAppUpdateDownloadingModal(t: Translate, info: UpdateInfo) {
  showAppUpdateModal(t, info, 'downloading')
}
