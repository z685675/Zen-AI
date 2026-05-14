type Translate = (key: string, options?: Record<string, unknown>) => string

export interface UpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
}

function formatReleaseDate(value?: string) {
  if (!value) {
    return undefined
  }

  const normalized = typeof value === 'string' ? value : String(value)
  const date = new Date(normalized)

  if (Number.isNaN(date.getTime())) {
    return normalized
  }

  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date)
}

function renderUpdateContent(t: Translate, updateInfo: UpdateInfo) {
  const releaseDate = formatReleaseDate(updateInfo.releaseDate)

  return (
    <div style={{ display: 'grid', gap: 12, lineHeight: 1.6 }}>
      <div style={{ fontWeight: 500 }}>{t('update.message', { version: updateInfo.version })}</div>
      <div>
        <strong>{t('update.version')}:</strong> {updateInfo.version}
      </div>
      {releaseDate && (
        <div>
          <strong>{t('update.releaseDate')}:</strong> {releaseDate}
        </div>
      )}
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
        {updateInfo.releaseNotes || t('update.noReleaseNotes')}
      </div>
    </div>
  )
}

export function showAppUpdateDownloadingToast(t: Translate, version: string) {
  window.toast.info(t('update.downloading', { version }))
}

export function showAppUpdateAvailableModal(t: Translate, updateInfo: UpdateInfo) {
  window.modal.confirm({
    title: t('update.title'),
    okText: t('update.installNow'),
    cancelText: t('update.later'),
    centered: true,
    width: 720,
    maskClosable: false,
    content: renderUpdateContent(t, updateInfo),
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
    content: renderUpdateContent(t, updateInfo),
    onOk() {
      return window.api.quitAndInstallUpdate()
    }
  })
}
