import type {
  ImageCanvasBridge,
  ImageCanvasCatalog,
  ImageCanvasModel,
  ImageCanvasModelConfiguration,
  ImageCanvasTask
} from '@shared/config/imageCanvas'
import { imageCanvasProtocols } from '@shared/config/imageCanvas'
import { defaultImageCapabilities, validateImageCapabilities } from '@shared/config/imageCapabilities'
import { type ChangeEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { blobToDataUrl } from './browserImages'
import { emptyDraft, readDraft, type WorkbenchDraft, writeDraft } from './draft'
import { dimensionKey, imageDimensionLabel, orderedImageDimensions } from './imageDimensions'
import { MaskEditor } from './MaskEditor'
import { TaskDiagnostics } from './TaskDiagnostics'

declare global {
  interface Window {
    imageCanvas?: ImageCanvasBridge
  }
}

export function FieldSelect({
  label,
  value,
  options,
  onChange,
  disabled
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const unavailable = value && !options.some((option) => option.value === value)
  return (
    <label className="field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled || !options.length}
        onChange={(event) => onChange(event.target.value)}>
        {unavailable && (
          <option value={value} disabled>
            {t('unsupportedValue', { value })}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function Configuration({
  model,
  onSave,
  onClose,
  error
}: {
  model: ImageCanvasModel
  onSave: (settings: ImageCanvasModelConfiguration | null) => Promise<void>
  onClose: () => void
  error: (error: unknown) => void
}) {
  const { t } = useTranslation()
  const capabilities = model.capabilities!
  const [settings, setSettings] = useState<ImageCanvasModelConfiguration>({
    protocol: model.protocol,
    sizes: [...new Set(capabilities.dimensions.map((d) => d.size).filter((s) => !s.includes(':')))],
    ratios: [...new Set(capabilities.dimensions.map((d) => d.ratio).filter((s) => s !== 'auto'))],
    resolutions: [...new Set(capabilities.dimensions.flatMap((d) => (d.resolution ? [d.resolution] : [])))],
    qualities: capabilities.qualities,
    backgrounds: capabilities.backgrounds,
    minReferences: capabilities.minReferences,
    maxReferences: capabilities.maxReferences,
    maxImages: capabilities.maxImages,
    supportsMask: capabilities.supportsMask,
    ...model.configuration
  })
  const [busy, setBusy] = useState(false)
  const [fields, setFields] = useState({
    sizes: settings.sizes.join(', '),
    ratios: settings.ratios.join(', '),
    resolutions: settings.resolutions.join(', '),
    qualities: settings.qualities.join(', '),
    backgrounds: settings.backgrounds.join(', ')
  })
  const save = async (reset: boolean) => {
    setBusy(true)
    try {
      const split = (value: string) =>
        value
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      await onSave(
        reset
          ? null
          : {
              ...settings,
              sizes: split(fields.sizes),
              ratios: split(fields.ratios),
              resolutions: split(fields.resolutions) as ImageCanvasModelConfiguration['resolutions'],
              qualities: ['openai', 'openai-json'].includes(settings.protocol) ? split(fields.qualities) : [],
              backgrounds: ['openai', 'openai-json'].includes(settings.protocol) ? split(fields.backgrounds) : []
            }
      )
      onClose()
    } catch (issue) {
      error(issue)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={t('configure')} onClose={onClose}>
      <p className="muted">{t('configurationHint')}</p>
      <FieldSelect
        label={t('protocol')}
        value={settings.protocol}
        options={imageCanvasProtocols.map((value) => ({ value, label: value }))}
        onChange={(value) => {
          const protocol = value as ImageCanvasModelConfiguration['protocol']
          const next = defaultImageCapabilities({ ...model, protocol })
          setSettings({
            protocol,
            sizes: [...new Set(next.dimensions.map((item) => item.size).filter((size) => !size.includes(':')))],
            ratios: [...new Set(next.dimensions.map((item) => item.ratio))].filter((item) => item !== 'auto'),
            resolutions: [...new Set(next.dimensions.flatMap((item) => (item.resolution ? [item.resolution] : [])))],
            qualities: next.qualities,
            backgrounds: next.backgrounds,
            minReferences: next.minReferences,
            maxReferences: next.maxReferences,
            maxImages: next.maxImages,
            supportsMask: next.supportsMask
          })
          setFields({
            sizes: [...new Set(next.dimensions.map((item) => item.size).filter((size) => !size.includes(':')))].join(
              ', '
            ),
            ratios: [...new Set(next.dimensions.map((item) => item.ratio))]
              .filter((item) => item !== 'auto')
              .join(', '),
            resolutions: '1K, 2K, 4K',
            qualities: next.qualities.join(', '),
            backgrounds: next.backgrounds.join(', ')
          })
        }}
      />
      <p className="muted">{t('protocolHint')}</p>
      {settings.protocol === 'openai-json' && (
        <FieldSelect
          label={t('imageField')}
          value={settings.imageField || 'images'}
          options={['images', 'image'].map((value) => ({ value, label: value }))}
          onChange={(value) => setSettings((current) => ({ ...current, imageField: value as 'image' | 'images' }))}
        />
      )}
      {settings.protocol === 'comfyui' && (
        <label className="field">
          <span>{t('workflow')}</span>
          <textarea
            rows={6}
            value={settings.workflow || ''}
            maxLength={200000}
            placeholder={t('workflowHint', { interpolation: { prefix: '[[', suffix: ']]' } })}
            onChange={(event) => setSettings((value) => ({ ...value, workflow: event.target.value }))}
          />
        </label>
      )}
      {['openai', 'openai-json', 'comfyui', 'dashscope'].includes(settings.protocol) && (
        <label className="check-field">
          <input
            type="checkbox"
            checked={!!settings.supportsMask}
            onChange={(event) => setSettings((value) => ({ ...value, supportsMask: event.target.checked }))}
          />
          {t('supportsMask')}
        </label>
      )}
      {(['sizes', 'ratios', 'resolutions', 'qualities', 'backgrounds'] as const)
        .filter((key) =>
          settings.protocol === 'gemini'
            ? ['ratios', 'resolutions'].includes(key)
            : !['ratios', 'resolutions'].includes(key)
        )
        .map((key) => (
          <label className="field" key={key}>
            <span>{t(key)}</span>
            <input
              value={fields[key]}
              onChange={(event) => setFields((value) => ({ ...value, [key]: event.target.value }))}
            />
          </label>
        ))}
      <div className="settings-grid">
        {(['minReferences', 'maxReferences', 'maxImages'] as const).map((key) => (
          <label className="field" key={key}>
            <span>{t(key)}</span>
            <input
              type="number"
              min={key === 'maxImages' ? 1 : 0}
              max={key === 'maxImages' && !['openai', 'openai-json'].includes(settings.protocol) ? 1 : 4}
              value={settings[key]}
              onChange={(event) => setSettings((value) => ({ ...value, [key]: Number(event.target.value) }))}
            />
          </label>
        ))}
      </div>
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => void save(true)}>
          {t('reset')}
        </button>
        <button type="button" disabled={busy} className="primary" onClick={() => void save(false)}>
          {t('apply')}
        </button>
      </div>
    </Modal>
  )
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    element?.showModal()
    return () => {
      element?.close()
      previous?.focus()
    }
  }, [])
  return (
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={onClose} className="modal">
      <header>
        <strong id={titleId}>{title}</strong>
        <button type="button" aria-label={t('close')} onClick={onClose}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  )
}

export default function Workbench() {
  const { t, i18n } = useTranslation()
  const bridge = window.imageCanvas
  const [catalog, setCatalog] = useState<ImageCanvasCatalog>([])
  const [draft, setDraft] = useState<WorkbenchDraft>({ ...emptyDraft })
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [hydrated, setHydrated] = useState(false)
  const [tasks, setTasks] = useState<ImageCanvasTask[]>([])
  // Undefined selects the latest task on entry; an empty string keeps a new draft blank.
  const [selectedId, setSelectedId] = useState<string>()
  const [images, setImages] = useState<Array<{ id: string; data: string }>>([])
  const [message, setMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [history, setHistory] = useState(false)
  const [configuration, setConfiguration] = useState(false)
  const [preview, setPreview] = useState('')
  const [maskEditor, setMaskEditor] = useState(false)
  const [nextCursor, setNextCursor] = useState<string>()
  const [historyTotal, setHistoryTotal] = useState(0)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const olderLoaded = useRef(false)
  const [comparisonImages, setComparisonImages] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const promptInput = useRef<HTMLTextAreaElement>(null)
  const draftVersion = useRef(0)
  const historyButton = useRef<HTMLButtonElement>(null)
  const uploads = useRef(Promise.resolve())
  const pendingUploads = useRef(0)
  const [readingImages, setReadingImages] = useState(false)
  const task = tasks.find((item) => item.id === selectedId)
  const comparisonTasks = task?.batchId ? tasks.filter((value) => value.batchId === task.batchId) : []
  const provider = catalog.find((item) => item.id === draft.providerId)
  const model = provider?.models.find((item) => item.id === draft.modelId)
  const capabilities = model?.capabilities
  const dimension = capabilities?.dimensions.find((item) => dimensionKey(item) === draft.dimension)
  const dimensions = orderedImageDimensions(capabilities?.dimensions || [])

  const showError = useCallback(
    (issue: unknown) => {
      const raw = issue instanceof Error ? issue.message : String(issue)
      const http = /(?:upstream|studio)_http_(\d{3})/.exec(raw)
      if (http) {
        setMessage(t('errors.http', { status: http[1] }))
        return
      }
      const code = raw.match(/(?:Error:\s*)?([a-z][a-z0-9_]+)$/)?.[1] || 'generic'
      setMessage(t('errors.' + code, { defaultValue: t('errors.generic') }))
    },
    [t]
  )

  const refresh = useCallback(async () => {
    if (!bridge) return
    setLoadingCatalog(true)
    try {
      const list = await bridge.catalog()
      setCatalog(list)
      setDraft((current) => {
        if (current.providerId) return current
        const first = list.find((item) => item.models.length)
        const firstModel = first?.models[0]
        const firstDimension = orderedImageDimensions(firstModel?.capabilities?.dimensions || [])[0]
        return first && firstModel
          ? {
              ...current,
              providerId: first.id,
              modelId: firstModel.id,
              dimension: firstDimension ? dimensionKey(firstDimension) : ''
            }
          : current
      })
    } catch (issue) {
      showError(issue)
    } finally {
      setLoadingCatalog(false)
    }
  }, [bridge, showError])

  useEffect(() => {
    let cancelled = false
    void readDraft()
      .then((stored) => {
        if (!cancelled) setDraft(stored)
      })
      .catch(showError)
      .finally(() => {
        if (!cancelled) setHydrated(true)
      })
    return () => {
      cancelled = true
    }
  }, [showError])
  useEffect(() => {
    if (hydrated) void refresh()
  }, [hydrated, refresh])
  useEffect(() => {
    if (!hydrated) return
    const timeout = setTimeout(() => {
      void writeDraft(draft).catch(showError)
    }, 700)
    return () => clearTimeout(timeout)
  }, [draft, hydrated, showError])
  useEffect(() => {
    if (!bridge || !hydrated) return
    return bridge.flush(async () => {
      await writeDraft(draftRef.current).catch(showError)
      void refresh()
    })
  }, [bridge, hydrated, refresh, showError])

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    const poll = async () => {
      try {
        const page = bridge.historyPage ? await bridge.historyPage(undefined, 30) : undefined
        const list = page ? page.items : await bridge.history()
        if (!cancelled) {
          setTasks((current) => [...list, ...current.filter((item) => !list.some((value) => value.id === item.id))])
          setHistoryTotal(page?.total ?? list.length)
          if (!olderLoaded.current) setNextCursor(page?.nextCursor)
          setSelectedId((id) => id ?? list[0]?.id ?? '')
        }
      } catch (issue) {
        if (!cancelled) showError(issue)
      }
    }
    void poll()
    const interval = setInterval(() => {
      void poll()
    }, 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [bridge, showError])
  const assetIds = task?.assets.join(',') || ''
  useEffect(() => {
    let cancelled = false
    setImages([])
    if (bridge && assetIds)
      void Promise.all(assetIds.split(',').map(async (id) => ({ id, data: await bridge.asset(id) })))
        .then((values) => {
          if (!cancelled) setImages(values)
        })
        .catch((issue) => {
          if (!cancelled) showError(issue)
        })
    return () => {
      cancelled = true
    }
  }, [bridge, assetIds, showError])
  const comparisonAssets = comparisonTasks.flatMap((value) => value.assets).join(',')
  useEffect(() => {
    let cancelled = false
    setComparisonImages({})
    if (bridge && comparisonAssets)
      void Promise.all(comparisonAssets.split(',').map(async (id) => [id, await bridge.asset(id)] as const))
        .then((values) => {
          if (!cancelled) setComparisonImages(Object.fromEntries(values))
        })
        .catch((issue) => {
          if (!cancelled) showError(issue)
        })
    return () => {
      cancelled = true
    }
  }, [bridge, comparisonAssets, showError])
  const loadMoreHistory = async () => {
    if (!bridge?.historyPage || !nextCursor || loadingHistory) return
    setLoadingHistory(true)
    try {
      const page = await bridge.historyPage(nextCursor, 30)
      olderLoaded.current = true
      setTasks((current) => [
        ...current,
        ...page.items.filter((item) => !current.some((value) => value.id === item.id))
      ])
      setNextCursor(page.nextCursor)
      setHistoryTotal(page.total)
    } catch (issue) {
      showError(issue)
    } finally {
      setLoadingHistory(false)
    }
  }

  const addImages = async (files: File[]) => {
    if (!files.length) return
    pendingUploads.current++
    setReadingImages(true)
    const operation = uploads.current.then(async () => {
      try {
        if (files.some((file) => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)))
          throw new Error('invalid_image')
        if (files.length + draftRef.current.references.length > 4)
          throw new Error('image_reference_or_count_unsupported')
        const existingBytes = draftRef.current.references.reduce(
          (sum, value) => sum + (value.length - value.indexOf(',') - 1) * 0.75,
          0
        )
        if (existingBytes + files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024)
          throw new Error('references_too_large')
        const values = await Promise.all(files.map(blobToDataUrl))
        const current = draftRef.current
        if (values.length + current.references.length > 4) throw new Error('image_reference_or_count_unsupported')
        const next = {
          ...current,
          references: [...current.references, ...values],
          mask: undefined,
          expansion: undefined
        }
        if (
          next.references.reduce((sum, value) => sum + (value.length - value.indexOf(',') - 1) * 0.75, 0) >
          20 * 1024 * 1024
        )
          throw new Error('references_too_large')
        draftRef.current = next
        setDraft(next)
        setMessage('')
      } catch (issue) {
        showError(issue)
      } finally {
        pendingUploads.current--
        if (!pendingUploads.current) setReadingImages(false)
      }
    })
    uploads.current = operation
    await operation
  }
  const chooseModel = (providerId: string, modelId: string) => {
    setDraft((current) => ({
      ...current,
      providerId,
      modelId,
      comparisons: current.comparisons?.filter(
        (target) => target.providerId !== providerId || target.modelId !== modelId
      )
    }))
    setMessage('')
  }

  const activeTask = tasks.some((item) => item.status === 'running')
  let valid =
    !!bridge &&
    !!model &&
    !!dimension &&
    !!draft.prompt.trim() &&
    !submitting &&
    !activeTask &&
    !readingImages &&
    hydrated
  let incompatible = false
  if (capabilities && dimension) {
    try {
      validateImageCapabilities(
        {
          id: '',
          providerId: draft.providerId,
          modelId: draft.modelId,
          prompt: draft.prompt,
          references: draft.references,
          size: dimension.size,
          aspectRatio: dimension.ratio,
          resolution: dimension.resolution,
          count: draft.count,
          quality: draft.quality,
          background: draft.background,
          mask: draft.mask,
          expansion: draft.expansion
        },
        capabilities
      )
    } catch {
      valid = false
      incompatible = true
    }
  }
  const targets = [{ providerId: draft.providerId, modelId: draft.modelId }, ...(draft.comparisons || [])]
  for (const target of targets.slice(1)) {
    const selected = catalog
      .find((provider) => provider.id === target.providerId)
      ?.models.find((model) => model.id === target.modelId)
    try {
      if (!selected?.capabilities || !dimension) throw new Error('model_unavailable')
      validateImageCapabilities(
        {
          id: '',
          ...target,
          prompt: draft.prompt,
          references: draft.references,
          size: dimension.size,
          resolution: dimension.resolution,
          aspectRatio: dimension.ratio,
          quality: draft.quality,
          background: draft.background,
          count: draft.count,
          mask: draft.mask,
          expansion: draft.expansion
        },
        selected.capabilities
      )
    } catch {
      valid = false
      incompatible = true
    }
  }
  const generate = async () => {
    if (!bridge || !valid || !dimension || submittingRef.current || pendingUploads.current) return
    if (task?.status === 'uncertain' && !window.confirm(t('confirmGenerate'))) return
    submittingRef.current = true
    setSubmitting(true)
    setMessage('')
    setNotice('')
    try {
      const input = {
        id: crypto.randomUUID(),
        providerId: draft.providerId,
        modelId: draft.modelId,
        prompt: draft.prompt,
        references: [...draft.references],
        size: dimension.size,
        aspectRatio: dimension.ratio,
        resolution: dimension.resolution,
        count: draft.count,
        quality: draft.quality,
        background: draft.background,
        mask: draft.mask,
        expansion: draft.expansion
      }
      let values: ImageCanvasTask[]
      if (targets.length > 1) {
        if (!bridge.submitBatch) throw new Error('batch_unavailable')
        const batchId = crypto.randomUUID()
        values = await bridge.submitBatch(
          targets.map((target) => ({ ...input, ...target, id: crypto.randomUUID(), batchId }))
        )
      } else values = [await bridge.submit(input)]
      setTasks((items) => [...values, ...items.filter((item) => !values.some((value) => value.id === item.id))])
      setSelectedId(values[0].id)
    } catch (issue) {
      showError(issue)
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }
  const reuse = async (value: ImageCanvasTask) => {
    if (!bridge) return
    const version = ++draftVersion.current
    try {
      const references = await Promise.all((value.referenceAssets || []).map((id) => bridge.asset(id)))
      const mask = value.maskAsset ? await bridge.asset(value.maskAsset) : undefined
      if (version !== draftVersion.current) return
      const parameters = value.parameters
      const selectedModel = catalog
        .find((item) => item.id === value.providerId)
        ?.models.find((item) => item.id === value.modelId)
      const selectedDimension = selectedModel?.capabilities?.dimensions.find(
        (item) =>
          item.size === parameters?.size &&
          item.resolution === parameters?.resolution &&
          (!parameters.aspectRatio || item.ratio === parameters.aspectRatio)
      )
      setDraft({
        ...emptyDraft,
        providerId: value.providerId,
        modelId: value.modelId,
        prompt: value.prompt,
        references,
        dimension: selectedDimension ? dimensionKey(selectedDimension) : '',
        quality: parameters?.quality || 'auto',
        background: parameters?.background || 'auto',
        count: parameters?.count || 1,
        mask,
        expansion: parameters?.expansion
      })
      if (!parameters) setNotice(t('oldParameters'))
    } catch (issue) {
      if (version === draftVersion.current) showError(issue)
    }
  }
  const newImage = () => {
    if (!hydrated || submittingRef.current || pendingUploads.current) return
    draftVersion.current++
    const next = {
      ...draftRef.current,
      prompt: '',
      references: [],
      mask: undefined,
      expansion: undefined,
      comparisons: []
    }
    draftRef.current = next
    setDraft(next)
    setSelectedId('')
    setImages([])
    setComparisonImages({})
    setPreview('')
    setMaskEditor(false)
    setConfiguration(false)
    setMessage('')
    setNotice('')
    promptInput.current?.focus()
  }
  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    void addImages(Array.from(event.target.files || []))
    event.target.value = ''
  }
  const taskStatus = (value: ImageCanvasTask) =>
    value.status === 'uncertain' && value.error === 'studio_download_failed'
      ? t('downloadPendingTitle')
      : value.status === 'running'
        ? t(value.phase || 'running')
        : t(value.status)
  const status = task ? taskStatus(task) : ''
  return (
    <div
      className="workbench"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDrop={(event) => {
        event.preventDefault()
        void addImages(Array.from(event.dataTransfer.files))
      }}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files)
        if (files.length) {
          event.preventDefault()
          void addImages(files)
        }
      }}>
      <header className="topbar">
        <div>
          <h1>{t('title')}</h1>
          <span className="muted">{t('subtitle')}</span>
        </div>
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={!hydrated || submitting || readingImages}
            onClick={newImage}>
            + {t('newImage')}
          </button>
          <button type="button" disabled={loadingCatalog} onClick={() => void refresh()}>
            {loadingCatalog ? '◌' : '↻'} {t('refresh')}
          </button>
          <button
            ref={historyButton}
            type="button"
            aria-controls="image-history"
            aria-expanded={history}
            onClick={() => setHistory((value) => !value)}>
            ◷ {t('history')} {historyTotal > 0 && <span className="badge">{historyTotal}</span>}
          </button>
        </div>
      </header>
      <div className={`studio-layout ${history ? 'with-history' : ''}`}>
        {history && (
          <aside
            id="image-history"
            className="history"
            aria-label={t('history')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setHistory(false)
                historyButton.current?.focus()
              }
            }}>
            <header>
              <strong>{t('history')}</strong>
              <button type="button" aria-label={t('close')} onClick={() => setHistory(false)}>
                ×
              </button>
            </header>
            <small className="muted">{t('historyLoaded', { loaded: tasks.length, total: historyTotal })}</small>
            <div className="history-list">
              {!tasks.length && <p className="muted">{t('noHistory')}</p>}
              {tasks.map((value) => (
                <button
                  type="button"
                  className={`history-item ${value.id === selectedId ? 'selected' : ''}`}
                  key={value.id}
                  aria-current={value.id === selectedId ? 'true' : undefined}
                  onClick={() => setSelectedId(value.id)}>
                  <span className={`status-dot ${value.status}`} />
                  <div>
                    <strong>{value.prompt}</strong>
                    <small>
                      {value.providerName || value.providerId} · {value.modelName || value.modelId}
                    </small>
                    <small>
                      {new Date(value.createdAt).toLocaleString(i18n.language)} · {taskStatus(value)}
                    </small>
                  </div>
                </button>
              ))}
            </div>
            {nextCursor && (
              <button type="button" disabled={loadingHistory} onClick={() => void loadMoreHistory()}>
                {loadingHistory ? t('loading') : t('loadMore')}
              </button>
            )}
          </aside>
        )}
        <main>
          {comparisonTasks.length > 1 && (
            <section className="comparison-results" aria-label={t('comparison')}>
              {comparisonTasks.map((value) => (
                <article className="comparison-card" key={value.id}>
                  <strong>
                    {value.providerName || value.providerId} · {value.modelName || value.modelId}
                  </strong>
                  <span role="status">{taskStatus(value)}</span>
                  {value.assets.map(
                    (id) =>
                      comparisonImages[id] && (
                        <button
                          type="button"
                          className="image-button"
                          key={id}
                          onClick={() => {
                            setSelectedId(value.id)
                            setPreview(comparisonImages[id])
                          }}
                          aria-label={t('preview')}>
                          <img src={comparisonImages[id]} alt={value.prompt} />
                        </button>
                      )
                  )}
                  <button type="button" onClick={() => setSelectedId(value.id)}>
                    {t('taskDetails')}
                  </button>
                </article>
              ))}
            </section>
          )}
          <section className={`preview ${images.length > 1 ? 'multiple' : ''}`} aria-live="polite">
            {images.length ? (
              images.map((image) => (
                <figure key={image.id}>
                  <button
                    type="button"
                    className="image-button"
                    onClick={() => setPreview(image.data)}
                    aria-label={t('preview')}>
                    <img src={image.data} alt={task?.prompt || ''} />
                  </button>
                  <figcaption>
                    <button
                      type="button"
                      onClick={() =>
                        void bridge
                          ?.exportAsset(image.id, 'save')
                          .then((saved) => {
                            if (saved) setNotice(t('saved'))
                          })
                          .catch(showError)
                      }>
                      {t('save')}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void bridge
                          ?.exportAsset(image.id, 'copy')
                          .then(() => setNotice(t('copied')))
                          .catch(showError)
                      }>
                      {t('copy')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (draft.references.length >= 4) {
                          showError(new Error('image_reference_or_count_unsupported'))
                          return
                        }
                        setDraft((current) => ({
                          ...current,
                          references: [...current.references, image.data],
                          mask: undefined,
                          expansion: undefined
                        }))
                      }}>
                      {t('useReference')}
                    </button>
                  </figcaption>
                </figure>
              ))
            ) : (
              <div className="empty-preview">
                <div className={task?.status === 'running' ? 'art-icon spinning' : 'art-icon'}>
                  {task?.status === 'running' ? '◌' : '▧'}
                </div>
                <h2>{task ? status : t('emptyTitle')}</h2>
                <p>{task ? task.prompt : t('emptyHint')}</p>
              </div>
            )}
          </section>
          {task && (
            <section className={`task-info ${task.status}`}>
              <div>
                <span className={`status-dot ${task.status}`} />
                <strong role="status">{status}</strong>
                <span className="muted">
                  {task.providerName || task.providerId} · {task.modelName || task.modelId}
                </span>
              </div>
              {task.status === 'running' && <p>{t('runningHint')}</p>}
              {task.diagnostics?.generationSubmitted === false && task.status === 'failed' && (
                <p>{t('notSubmittedHint')}</p>
              )}
              {!!task.assets.length && task.assets.length < (task.parameters?.count || 1) && (
                <p>{t('partialResult', { have: task.assets.length, wanted: task.parameters?.count })}</p>
              )}
              {task.status === 'uncertain' && (
                <p>
                  {t(task.error === 'studio_download_failed' ? 'downloadPending' : 'uncertainHint')}
                  {!task.recoverable && task.diagnostics?.transport === 'direct' && ` ${t('directHint')}`}
                </p>
              )}
              {task.error && (
                <p>
                  {t('errors.' + task.error, {
                    defaultValue: /(?:upstream|studio)_http_(\d{3})/.test(task.error)
                      ? t('errors.http', { status: task.error.slice(-3) })
                      : t('errors.generic')
                  })}
                </p>
              )}
              <TaskDiagnostics task={task} />
              <div className="actions">
                {task.recoverable && task.status !== 'running' && task.status !== 'completed' && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() =>
                      void bridge
                        ?.recover(task.id)
                        .then((value) =>
                          setTasks((items) => items.map((item) => (item.id === value.id ? value : item)))
                        )
                        .catch(showError)
                    }>
                    {t('recover')}
                  </button>
                )}
                <button type="button" aria-describedby="image-reuse-hint" onClick={() => void reuse(task)}>
                  {t('reuse')}
                </button>
                {task.status !== 'running' && (
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(t('deleteConfirm')))
                        void bridge
                          ?.remove(task.id)
                          .then(() => {
                            setTasks((items) => items.filter((item) => item.id !== task.id))
                            setSelectedId('')
                          })
                          .catch(showError)
                    }}>
                    {t('removeTask')}
                  </button>
                )}
              </div>
              <small id="image-reuse-hint" className="muted reuse-hint">
                {t('reuseHint')}
              </small>
            </section>
          )}
        </main>
        <section className="composer">
          <div className="mode-line">
            <span className="mode-badge">{t(draft.references.length ? 'imageMode' : 'textMode')}</span>
          </div>
          <label className="field prompt-field">
            <span>{t('prompt')}</span>
            <textarea
              ref={promptInput}
              value={draft.prompt}
              maxLength={32000}
              placeholder={t('promptPlaceholder')}
              onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
              onKeyDown={(event) => {
                if (
                  (event.ctrlKey || event.metaKey) &&
                  event.key === 'Enter' &&
                  !event.nativeEvent.isComposing &&
                  !event.repeat
                ) {
                  event.preventDefault()
                  void generate()
                }
              }}
            />
          </label>
          <div className="reference-header">
            <strong>{t('references')}</strong>
            <small className="muted">
              {draft.references.length} / {capabilities?.maxReferences ?? 0}
            </small>
          </div>
          {readingImages && (
            <small role="status" className="muted">
              {t('readingImages')}
            </small>
          )}
          <div className="reference-grid">
            {draft.references.map((reference, index) => (
              <div className="reference" key={`${index}-${reference.slice(-24)}`}>
                <img src={reference} alt={t('references')} />
                <button
                  type="button"
                  aria-label={t('removeImage', { index: index + 1 })}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      references: current.references.filter((_, i) => i !== index),
                      mask: undefined,
                      expansion: undefined
                    }))
                  }>
                  ×
                </button>
                <span>{index + 1}</span>
              </div>
            ))}
            <button
              type="button"
              className="upload"
              disabled={draft.references.length >= 4}
              onClick={() => fileInput.current?.click()}>
              <span>＋</span>
              {t('addImages')}
            </button>
          </div>
          <small className="muted upload-hint">{t('uploadHint')}</small>
          {(draft.mask || draft.expansion) && (
            <div className="actions">
              <small>{t(draft.mask ? 'maskApplied' : 'expansionApplied')}</small>
              <button
                type="button"
                onClick={() => setDraft((value) => ({ ...value, mask: undefined, expansion: undefined }))}>
                {t('clearMask')}
              </button>
            </div>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={onFiles}
          />
          <div className="settings-grid">
            <FieldSelect
              label={t('provider')}
              value={draft.providerId}
              options={catalog.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(id) => chooseModel(id, catalog.find((item) => item.id === id)?.models[0]?.id || '')}
            />
            <FieldSelect
              label={t('model')}
              value={draft.modelId}
              options={provider?.models.map((item) => ({ value: item.id, label: item.name })) || []}
              onChange={(id) => chooseModel(draft.providerId, id)}
            />
            {capabilities && (
              <div className="image-size-field">
                <FieldSelect
                  label={t('imageSize')}
                  value={dimension ? draft.dimension : ''}
                  options={[
                    ...(!dimension ? [{ value: '', label: t('chooseDimension') }] : []),
                    ...dimensions.map((item) => ({ value: dimensionKey(item), label: imageDimensionLabel(item, t) }))
                  ]}
                  onChange={(value) => setDraft((current) => ({ ...current, dimension: value }))}
                />
              </div>
            )}
          </div>
          {capabilities && (
            <small className="muted">
              {t(capabilities.source)} ·{' '}
              {t('referenceLimit', { min: capabilities.minReferences, max: capabilities.maxReferences })}
            </small>
          )}
          <section id="image-advanced" className="advanced" aria-label={t('more')}>
            <h2>{t('more')}</h2>
            {capabilities?.supportsMask && draft.references.length === 1 && (
              <section className="editing-settings" aria-label={t('advancedEditing')}>
                <h3>{t('advancedEditing')}</h3>
                <button type="button" onClick={() => setMaskEditor(true)}>
                  {t('maskEditor')}
                </button>
                <p className="muted">{t('expansionHint')}</p>
                <div className="settings-grid">
                  {(['top', 'right', 'bottom', 'left'] as const).map((edge) => (
                    <label className="field" key={edge}>
                      <span>{t('edge.' + edge)}</span>
                      <input
                        type="number"
                        min={0}
                        max={2048}
                        step={16}
                        value={draft.expansion?.[edge] || 0}
                        onChange={(event) => {
                          const expansion = {
                            top: 0,
                            right: 0,
                            bottom: 0,
                            left: 0,
                            ...draft.expansion,
                            [edge]: Number(event.target.value)
                          }
                          setDraft((value) => ({
                            ...value,
                            mask: undefined,
                            expansion: Object.values(expansion).some((value) => value > 0) ? expansion : undefined
                          }))
                        }}
                      />
                    </label>
                  ))}
                </div>
              </section>
            )}
            <div className="settings-grid">
              {(!!capabilities?.qualities.length || draft.quality !== 'auto') && (
                <FieldSelect
                  label={t('quality')}
                  value={draft.quality}
                  options={[...new Set(['auto', ...(capabilities?.qualities || [])])].map((value) => ({
                    value,
                    label: t(value, { defaultValue: value })
                  }))}
                  onChange={(value) => setDraft((current) => ({ ...current, quality: value }))}
                />
              )}
              {(!!capabilities?.backgrounds.length || draft.background !== 'auto') && (
                <FieldSelect
                  label={t('background')}
                  value={draft.background}
                  options={[...new Set(['auto', ...(capabilities?.backgrounds || [])])].map((value) => ({
                    value,
                    label: t(value, { defaultValue: value })
                  }))}
                  onChange={(value) => setDraft((current) => ({ ...current, background: value }))}
                />
              )}
              {((capabilities?.maxImages || 0) > 1 || draft.count > (capabilities?.maxImages || 1)) && (
                <FieldSelect
                  label={t('count')}
                  value={String(draft.count)}
                  options={Array.from({ length: capabilities?.maxImages || 1 }, (_, i) => ({
                    value: String(i + 1),
                    label: String(i + 1)
                  }))}
                  onChange={(value) => setDraft((current) => ({ ...current, count: Number(value) }))}
                />
              )}
            </div>
            {model && capabilities?.source !== 'server' && (
              <button type="button" onClick={() => setConfiguration(true)}>
                {t('configure')}
              </button>
            )}
            <section className="model-comparison" aria-label={t('comparison')}>
              <h3>{t('comparison')}</h3>
              <p className="muted">{t('comparisonHint')}</p>
              <div className="comparison-models">
                {catalog
                  .flatMap((provider) => provider.models.map((model) => ({ provider, model })))
                  .filter((value) => value.provider.id !== draft.providerId || value.model.id !== draft.modelId)
                  .map((value) => {
                    const checked = (draft.comparisons || []).some(
                      (target) => target.providerId === value.provider.id && target.modelId === value.model.id
                    )
                    return (
                      <label className="check-field" key={JSON.stringify([value.provider.id, value.model.id])}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!checked && (draft.comparisons?.length || 0) >= 3}
                          onChange={() =>
                            setDraft((current) => ({
                              ...current,
                              comparisons: checked
                                ? current.comparisons?.filter(
                                    (target) =>
                                      target.providerId !== value.provider.id || target.modelId !== value.model.id
                                  )
                                : [
                                    ...(current.comparisons || []),
                                    { providerId: value.provider.id, modelId: value.model.id }
                                  ]
                            }))
                          }
                        />
                        {value.provider.name} · {value.model.name}
                      </label>
                    )
                  })}
              </div>
            </section>
          </section>
          {!catalog.length && !loadingCatalog && (
            <div className="callout">
              <strong>{t('noProviders')}</strong>
              <p>{t('noProvidersHint')}</p>
            </div>
          )}
          {provider?.error && (
            <p className="error">{t('errors.' + provider.error, { defaultValue: t('errors.catalog_unavailable') })}</p>
          )}
          {provider && !model && <p className="error">{t('noModel')}</p>}
          {model && capabilities && !dimension && <p className="error">{t('chooseDimension')}</p>}
          {incompatible && <p className="error">{t('unsupported')}</p>}
          {targets.length > 1 && <p className="callout">{t('batchBilling', { count: targets.length })}</p>}
          <button
            type="button"
            className="primary generate"
            aria-keyshortcuts="Control+Enter Meta+Enter"
            disabled={!valid}
            onClick={() => void generate()}>
            {submitting
              ? t('submitting')
              : `${targets.length > 1 ? t('generateComparison', { count: targets.length }) : t('generate')} ↑`}
          </button>
        </section>
      </div>
      {message && (
        <div role="alert" className="toast error">
          <span>{message}</span>
          <button type="button" aria-label={t('close')} onClick={() => setMessage('')}>
            ×
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="toast">
          <span>{notice}</span>
          <button type="button" aria-label={t('close')} onClick={() => setNotice('')}>
            ×
          </button>
        </div>
      )}
      {configuration && model && (
        <Configuration
          model={model}
          error={showError}
          onClose={() => setConfiguration(false)}
          onSave={async (settings) => {
            await bridge!.configure(draft.providerId, draft.modelId, settings)
            await refresh()
          }}
        />
      )}
      {preview && (
        <Modal title={t('preview')} onClose={() => setPreview('')}>
          <img className="full-preview" src={preview} alt={task?.prompt || ''} />
        </Modal>
      )}
      {maskEditor && draft.references[0] && (
        <Modal title={t('maskEditor')} onClose={() => setMaskEditor(false)}>
          <MaskEditor
            image={draft.references[0]}
            onError={showError}
            onApply={(image, mask) => {
              setDraft((current) => ({ ...current, references: [image], mask, expansion: undefined }))
              setMaskEditor(false)
            }}
          />
        </Modal>
      )}
    </div>
  )
}
