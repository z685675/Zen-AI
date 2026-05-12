type Translate = (key: string, options?: Record<string, unknown>) => string

export interface UpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
}

function renderUpdateContent(t: Translate, updateInfo: UpdateInfo) {
  return (
    <div style={{ display: 'grid', gap: 12, lineHeight: 1.6 }}>
      <div style={{ fontWeight: 500 }}>{t('update.message', { version: updateInfo.version })}</div>
      <div>
        <strong>{t('update.version')}:</strong> {updateInfo.version}
      </div>
      {updateInfo.releaseDate && (
        <div>
          <strong>{t('update.releaseDate')}:</strong> {updateInfo.releaseDate}
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
