type Translate = (key: string, options?: Record<string, unknown>) => string

export interface UpdateInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string
  downloadPage: string
  mandatory?: boolean
}

export function showAppUpdateModal(t: Translate, updateInfo: UpdateInfo) {
  window.modal.confirm({
    title: t('update.title'),
    okText: t('update.install'),
    cancelText: t('update.later'),
    centered: true,
    content: (
      <div style={{ display: 'grid', gap: 12 }}>
        <div>{t('update.message', { version: updateInfo.version })}</div>
        <div>
          <strong>Version:</strong> {updateInfo.version}
        </div>
        {updateInfo.releaseDate && (
          <div>
            <strong>Date:</strong> {updateInfo.releaseDate}
          </div>
        )}
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
          {updateInfo.releaseNotes || t('update.noReleaseNotes')}
        </div>
      </div>
    ),
    onOk() {
      return window.api.openWebsite(updateInfo.downloadPage)
    }
  })
}
