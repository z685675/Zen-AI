import './videoWorkbench.css'

import {
  type VideoBridge,
  type VideoCatalog,
  type VideoRatio,
  videoRatios,
  videoResolutions,
  videoSizePattern,
  type VideoTask
} from '@shared/config/videoGeneration'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { blobToDataUrl } from './browserImages'
import { downloadSize } from './DownloadProgress'
import { PromptEditorModal } from './PromptEditorModal'

declare global {
  interface Window {
    videoWorkbench?: VideoBridge
  }
}

const activeStatuses = ['submitting', 'queued', 'running', 'downloading']
const durationPresets = [4, 6, 8, 10, 12]
const videoErrorCodes = [
  'invalid_image',
  'model_unavailable',
  'model_price_not_configured',
  'provider_key_missing',
  'provider_configuration_changed',
  'provider_unavailable',
  'too_many_tasks',
  'video_parameters_unsupported',
  'submit_uncertain',
  'video_result_pending',
  'video_generation_failed'
]

function statusLabel(task: VideoTask) {
  return task.status === 'uncertain' && task.readyToDownload ? 'video.downloadPending' : `video.status.${task.status}`
}

export function VideoWorkbench({
  active,
  firstFrame,
  onFirstFrame
}: {
  active: boolean
  firstFrame: string
  onFirstFrame: (value: string) => void
}) {
  const { t, i18n } = useTranslation()
  const bridge = window.videoWorkbench
  const [catalog, setCatalog] = useState<VideoCatalog>([])
  const [history, setHistory] = useState<VideoTask[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selected, setSelected] = useState('')
  const [modelKey, setModelKey] = useState('')
  const [prompt, setPrompt] = useState('')
  const [promptEditorOpen, setPromptEditorOpen] = useState(false)
  const [viewingPrompt, setViewingPrompt] = useState<string | null>(null)
  const [ratio, setRatio] = useState<VideoRatio>('adaptive')
  const [resolution, setResolution] = useState<number>()
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [seconds, setSeconds] = useState('')
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ id: string; url?: string; failed?: boolean }>()
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const action = useRef(false)
  const uploadVersion = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  const player = useRef<HTMLVideoElement>(null)
  const historyButton = useRef<HTMLButtonElement>(null)

  const options = useMemo(
    () =>
      catalog.flatMap((provider) =>
        provider.models.map((model) => ({
          model,
          provider,
          key: JSON.stringify([provider.id, model.id])
        }))
      ),
    [catalog]
  )
  const model = modelKey ? options.find((option) => option.key === modelKey) : options[0]
  const task = history.find((item) => item.id === selected)
  const taskError = task?.error
  const httpStatus = taskError?.match(/^video_http_(\d{3})$/)?.[1]
  const receivedBytes = task?.download?.receivedBytes ?? 0
  const totalBytes = task?.download?.totalBytes
  const completedId = task?.status === 'completed' ? task.id : undefined
  const currentPreview = preview?.id === completedId ? preview : undefined
  const clip = currentPreview?.url
  const loadingClip = !!completedId && !currentPreview
  const previewFailed = currentPreview?.failed
  const showPreviewWarning = previewFailed || task?.status === 'failed' || task?.status === 'uncertain'
  const canDownload = !!task?.recoverable && (task.status === 'uncertain' || previewFailed)
  const duration = seconds ? Number(seconds) : undefined
  const size = width || height ? `${width}x${height}` : undefined
  const validParameters =
    (duration === undefined || (Number.isSafeInteger(duration) && duration > 0)) &&
    (size === undefined || videoSizePattern.test(size))

  const selectSize = (nextRatio: VideoRatio, shortSide?: number) => {
    setRatio(nextRatio)
    setResolution(shortSide)
    if (nextRatio === 'adaptive' || shortSide === undefined) {
      setWidth('')
      setHeight('')
      return
    }
    const [horizontal, vertical] = nextRatio.split(':').map(Number)
    const unit = shortSide / Math.min(horizontal, vertical)
    setWidth(String(Math.round((horizontal * unit) / 2) * 2))
    setHeight(String(Math.round((vertical * unit) / 2) * 2))
  }

  const showError = useCallback(
    (issue: unknown) => {
      const message = issue instanceof Error ? issue.message : String(issue)
      const http = message.match(/video_http_(\d{3})/)
      const code = videoErrorCodes.find((item) => message.endsWith(item))
      setError(
        http
          ? t(http[1] === '415' ? 'video.unsupportedFormat' : 'video.http', { status: http[1] })
          : t(code ? `video.errors.${code}` : 'video.unavailable')
      )
    },
    [t]
  )

  useEffect(() => {
    if (!active) player.current?.pause()
  }, [active])

  useEffect(() => {
    if (!bridge || !active) return
    let cancelled = false
    void bridge
      .catalog()
      .then((items) => {
        if (!cancelled) setCatalog(items)
      })
      .catch((issue) => {
        if (!cancelled) showError(issue)
      })
    const readHistory = () =>
      void bridge
        .history()
        .then((items) => {
          if (!cancelled && !action.current) setHistory(items)
        })
        .catch((issue) => {
          if (!cancelled) showError(issue)
        })
    readHistory()
    const timer = setInterval(readHistory, 1800)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active, bridge, showError])

  useEffect(() => {
    setPreview(undefined)
    if (!bridge || !completedId) return
    let cancelled = false
    let url = ''
    void bridge
      .preview(completedId)
      .then((bytes) => {
        if (cancelled) return
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }))
        setPreview({ id: completedId, url })
      })
      .catch(() => {
        if (!cancelled) setPreview({ id: completedId, failed: true })
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [bridge, completedId])

  const setFrame = async (file: File) => {
    const version = ++uploadVersion.current
    setError('')
    setReading(true)
    try {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 20 * 1024 * 1024) throw new Error('invalid_image')
      const data = await blobToDataUrl(file)
      if (version === uploadVersion.current) onFirstFrame(data)
    } catch (issue) {
      if (version === uploadVersion.current) showError(issue)
    } finally {
      if (version === uploadVersion.current) setReading(false)
    }
  }
  const reset = () => {
    ++uploadVersion.current
    setReading(false)
    setPrompt('')
    setSelected('')
    setConfirmDelete(false)
    setError('')
    onFirstFrame('')
  }
  const closeHistory = () => {
    setHistoryOpen(false)
    historyButton.current?.focus()
  }
  const perform = async (operation: (api: VideoBridge) => Promise<void>) => {
    if (!bridge || action.current) return
    action.current = true
    setBusy(true)
    setError('')
    try {
      await operation(bridge)
      setHistory(await bridge.history())
    } catch (issue) {
      showError(issue)
    } finally {
      action.current = false
      setBusy(false)
    }
  }

  return (
    <div className="workbench">
      <header className="topbar">
        <div className="topbar-left">
          <h1>{t('video.title')}</h1>
          <div className="topbar-selectors">
            <label className="topbar-select topbar-select-model" htmlFor="video-model">
              <span>{t('model')}</span>
              <select
                id="video-model"
                aria-label={t('model')}
                value={model?.key || ''}
                disabled={!options.length}
                onChange={(event) => {
                  setModelKey(event.target.value)
                  selectSize('adaptive')
                  setSeconds('')
                }}>
                {!options.length && <option value="">{t('video.noModel')}</option>}
                {!!options.length && !model && <option value="">{t('video.chooseModel')}</option>}
                {options.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.model.name} · {option.provider.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="actions">
          <button type="button" className="primary" onClick={reset}>
            + {t('video.new')}
          </button>
          <button
            ref={historyButton}
            type="button"
            aria-controls="video-history"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}>
            <span aria-hidden="true">◷</span> {t('video.history')}{' '}
            {history.length > 0 && <span className="badge">{history.length}</span>}
          </button>
        </div>
      </header>
      <div className={`studio-layout video-layout${historyOpen ? ' with-history' : ''}`}>
        {historyOpen && (
          <aside
            id="video-history"
            className="history"
            aria-label={t('video.history')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeHistory()
            }}>
            <header>
              <strong>{t('video.history')}</strong>
              <button type="button" onClick={closeHistory} aria-label={t('close')}>
                ×
              </button>
            </header>
            <div className="history-list">
              {!history.length && <p className="muted">{t('video.noHistory')}</p>}
              {history.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`history-item${item.id === selected ? ' selected' : ''}`}
                  aria-current={item.id === selected ? 'true' : undefined}
                  onClick={() => {
                    setSelected(item.id)
                    setConfirmDelete(false)
                    setError('')
                  }}>
                  <span className={`status-dot ${item.status}`} />
                  <div>
                    <strong>{item.prompt}</strong>
                    <small>
                      {t(statusLabel(item))}
                      {item.seconds !== undefined && ` · ${t('video.secondsShort', { count: item.seconds })}`}
                    </small>
                    <small>{new Date(item.createdAt).toLocaleString(i18n.language)}</small>
                  </div>
                </button>
              ))}
            </div>
          </aside>
        )}
        <main className="video-output" aria-label={t('video.result')}>
          <h2>{t('video.result')}</h2>
          <div className="video-player" aria-live="polite">
            {clip ? (
              <video
                ref={player}
                key={clip}
                controls
                playsInline
                preload="metadata"
                src={clip}
                onError={() => {
                  if (completedId) setPreview({ id: completedId, failed: true })
                }}
                aria-label={t('video.result')}
              />
            ) : (
              <div className="video-empty">
                <span className="video-camera" aria-hidden="true" />
                <strong>
                  {t(
                    previewFailed
                      ? 'video.previewUnavailable'
                      : loadingClip
                        ? 'loading'
                        : task
                          ? statusLabel(task)
                          : 'video.noResult'
                  )}
                </strong>
                {showPreviewWarning && (
                  <p className="preview-warning">
                    {t(
                      canDownload
                        ? 'video.previewDownloadHint'
                        : task?.status === 'uncertain'
                          ? 'previewUnconfirmedHint'
                          : 'previewRegenerateHint'
                    )}
                  </p>
                )}
                {task?.status === 'downloading' && (
                  <div className="image-download video-download">
                    <progress
                      aria-label={t('video.downloadProgress')}
                      max={totalBytes}
                      value={totalBytes ? Math.min(receivedBytes, totalBytes) : undefined}
                    />
                    <div>
                      <span>
                        {downloadSize(receivedBytes)}
                        {totalBytes ? ` / ${downloadSize(totalBytes)}` : ` · ${t('downloadUnknownSize')}`}
                      </span>
                      {totalBytes ? (
                        <span>{Math.min(100, Math.floor((receivedBytes / totalBytes) * 100))}%</span>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          {task && (
            <div className="video-details">
              <div className="video-prompt-preview">
                <p className="video-prompt-text" title={task.prompt}>
                  {task.prompt}
                </p>
                {(task.prompt.trim().length > 100 || task.prompt.includes('\n')) && (
                  <button type="button" className="preview-prompt-more" onClick={() => setViewingPrompt(task.prompt)}>
                    {t('viewFullPrompt')}
                  </button>
                )}
              </div>
              <p className="muted">
                {[
                  task.modelId,
                  task.size || task.resolution,
                  task.seconds === undefined ? '' : t('video.secondsShort', { count: task.seconds })
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {taskError && (
                <p role="status">
                  {httpStatus
                    ? t(
                        task.readyToDownload
                          ? 'video.downloadHttp'
                          : httpStatus === '415'
                            ? 'video.unsupportedFormat'
                            : 'video.http',
                        { status: httpStatus }
                      )
                    : t(
                        task.readyToDownload && taskError === 'video_result_pending'
                          ? 'video.downloadFailed'
                          : videoErrorCodes.includes(taskError)
                            ? `video.errors.${taskError}`
                            : 'video.unavailable'
                      )}
                </p>
              )}
              <div className="actions">
                {task.status === 'completed' && !previewFailed && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(async (api) => {
                        await api.save(task.id)
                      })
                    }>
                    {t('video.save')}
                  </button>
                )}
                {canDownload && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => void perform((api) => api.recover(task.id))}>
                    {t('video.download')}
                  </button>
                )}
                <button type="button" onClick={() => setPrompt(task.prompt)}>
                  {t('video.reuse')}
                </button>
                {!activeStatuses.includes(task.status) &&
                  (confirmDelete ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void perform(async (api) => {
                            await api.remove(task.id)
                            setSelected('')
                            setConfirmDelete(false)
                          })
                        }>
                        {t('video.confirmDelete')}
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(false)}>
                        {t('video.cancel')}
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirmDelete(true)}>
                      {t('video.delete')}
                    </button>
                  ))}
              </div>
            </div>
          )}
          {error && (
            <p className="video-error" role="alert">
              {error}
            </p>
          )}
        </main>
        <form
          className="composer video-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (!model || !prompt.trim() || !validParameters || reading) return
            void perform(async (api) => {
              const task = await api.submit({
                id: crypto.randomUUID(),
                modelId: model.model.id,
                providerId: model.provider.id,
                prompt: prompt.trim(),
                size,
                seconds: duration,
                ...(firstFrame ? { firstFrame } : {})
              })
              setSelected(task.id)
              setConfirmDelete(false)
            })
          }}>
          <h2>{t('video.settings')}</h2>
          <div className="video-heading">
            <strong>{t('video.firstFrame')}</strong>
            <button type="button" onClick={() => input.current?.click()}>
              {t('video.upload')}
            </button>
          </div>
          <input
            ref={input}
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void setFrame(file)
            }}
          />
          <div
            className="video-drop"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              const file = event.dataTransfer.files[0]
              if (file) void setFrame(file)
            }}>
            {firstFrame ? (
              <>
                <img src={firstFrame} alt={t('video.firstFrame')} />
                <button
                  type="button"
                  onClick={() => {
                    ++uploadVersion.current
                    setReading(false)
                    onFirstFrame('')
                  }}>
                  {t('video.clearFrame')}
                </button>
              </>
            ) : (
              <span>{t(reading ? 'readingImages' : 'video.drop')}</span>
            )}
          </div>
          <div className="prompt-header">
            <label htmlFor="video-prompt">{t('prompt')}</label>
            <button
              type="button"
              className={`prompt-expand-btn${prompt.length > 90 || prompt.includes('\n') ? ' emphasized' : ''}`}
              title={t('expandPrompt')}
              onClick={() => setPromptEditorOpen(true)}>
              <span aria-hidden="true">⤢</span>
              <span>{t('expandPrompt')}</span>
            </button>
          </div>
          <textarea
            id="video-prompt"
            rows={4}
            maxLength={5000}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('video.promptPlaceholder')}
          />
          <fieldset className="video-options">
            <legend>{t('video.resolution')}</legend>
            <div className="video-segments video-resolutions">
              {videoResolutions.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={item === resolution}
                  onClick={() => selectSize(ratio === 'adaptive' ? '16:9' : ratio, item)}>
                  {item}p
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="video-options">
            <legend>{t('video.size')}</legend>
            <div className="video-segments video-ratios">
              {videoRatios.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={item === ratio && (item !== 'adaptive' || !size)}
                  onClick={() => selectSize(item, item === 'adaptive' ? undefined : resolution || 720)}>
                  {item !== 'adaptive' && (
                    <span
                      className="video-ratio-icon"
                      style={{
                        aspectRatio: item.replace(':', '/'),
                        width: item === '9:16' || item === '3:4' ? 12 : 20
                      }}
                    />
                  )}
                  <span>{t(['video.ratio', item.replace(':', '-')].join('.'))}</span>
                  {item !== 'adaptive' && <small>{item}</small>}
                </button>
              ))}
            </div>
            <div className="video-dimensions">
              <input
                aria-label={t('video.width')}
                type="text"
                inputMode="numeric"
                maxLength={5}
                placeholder={t('video.width')}
                value={width}
                onChange={(event) => {
                  setWidth(event.target.value)
                  setRatio('adaptive')
                  setResolution(undefined)
                }}
              />
              <span aria-hidden="true">×</span>
              <input
                aria-label={t('video.height')}
                type="text"
                inputMode="numeric"
                maxLength={5}
                placeholder={t('video.height')}
                value={height}
                onChange={(event) => {
                  setHeight(event.target.value)
                  setRatio('adaptive')
                  setResolution(undefined)
                }}
              />
            </div>
          </fieldset>
          <fieldset className="video-options">
            <legend>{t('video.seconds')}</legend>
            <div className="video-segments">
              {durationPresets.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={value === duration}
                  onClick={() => setSeconds(String(value))}>
                  {t('video.secondsShort', { count: value })}
                </button>
              ))}
              <label className="video-custom-seconds">
                <span className="muted">{t('video.custom')}</span>
                <input
                  type="number"
                  aria-label={t('video.customSeconds')}
                  min={1}
                  placeholder={t('video.defaultSeconds')}
                  value={seconds}
                  onChange={(event) => setSeconds(event.target.value)}
                />
              </label>
            </div>
          </fieldset>
          <button
            className="primary video-submit"
            type="submit"
            disabled={busy || reading || !bridge || !model || !prompt.trim() || !validParameters}>
            {t('video.generate')}
          </button>
        </form>
      </div>
      {promptEditorOpen && (
        <PromptEditorModal
          value={prompt}
          maxLength={5000}
          placeholder={t('video.promptPlaceholder')}
          onChange={setPrompt}
          onClose={() => setPromptEditorOpen(false)}
        />
      )}
      {viewingPrompt !== null && (
        <PromptEditorModal readOnly value={viewingPrompt} onClose={() => setViewingPrompt(null)} />
      )}
    </div>
  )
}
