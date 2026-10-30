import type { ImageCanvasBridge, ImageCanvasTask } from '@shared/config/imageCanvas'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  bridge: ImageCanvasBridge
  tasks: ImageCanvasTask[]
  selectedTaskId: string
  onSelect: (id: string) => void
  taskStatus: (task: ImageCanvasTask) => string
  onPreview: (data: string) => void
  onUseReference: (data: string) => void
  onNotice: (message: string) => void
  onError: (error: unknown) => void
}

export function ResultGallery({
  bridge,
  tasks,
  selectedTaskId,
  onSelect,
  taskStatus,
  onPreview,
  onUseReference,
  onNotice,
  onError
}: Props) {
  const { t } = useTranslation()
  const [selectedAssetId, setSelectedAssetId] = useState<string>()
  const [images, setImages] = useState<Record<string, string>>({})
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set())
  const selectedThumbnail = useRef<HTMLButtonElement>(null)
  // Pending and failed requests keep a slot so that completion never changes
  // which request is selected or makes a failed image disappear from a batch.
  const pages = tasks.flatMap<{ task: ImageCanvasTask; assetId: string | undefined }>((task) =>
    task.assets.length ? task.assets.map((assetId) => ({ task, assetId })) : [{ task, assetId: undefined }]
  )
  let index = pages.findIndex((page) => page.task.id === selectedTaskId && page.assetId === selectedAssetId)
  if (index < 0)
    index = Math.max(
      0,
      pages.findIndex((page) => page.task.id === selectedTaskId)
    )
  const page = pages[index]
  const data = page?.assetId ? images[page.assetId] : undefined
  const assetIds = tasks.flatMap((task) => task.assets).join(',')
  useEffect(() => {
    let cancelled = false
    const ids = assetIds ? assetIds.split(',') : []
    setFailedImages(new Set())
    setImages((current) => Object.fromEntries(ids.filter((id) => current[id]).map((id) => [id, current[id]])))
    // An unreadable image must not hide the other successfully saved results.
    for (const id of ids) {
      void bridge
        .asset(id)
        .then((value) => {
          if (!cancelled) setImages((current) => ({ ...current, [id]: value }))
        })
        .catch((error) => {
          if (!cancelled) {
            setFailedImages((current) => new Set([...current, id]))
            onError(error)
          }
        })
    }
    return () => {
      cancelled = true
    }
  }, [assetIds, bridge, onError])
  const pageKey = page ? `${page.task.id}:${page.assetId ?? ''}` : ''
  useEffect(() => {
    selectedThumbnail.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [pageKey])
  const select = (next: number) => {
    const value = pages[next]
    if (!value) return
    setSelectedAssetId(value.assetId)
    onSelect(value.task.id)
  }
  const exportImage = async (action: 'save' | 'copy') => {
    if (!page?.assetId || !data) return
    try {
      const exported = await bridge.exportAsset(page.assetId, action)
      if (exported) onNotice(t(action === 'save' ? 'saved' : 'copied'))
    } catch (error) {
      onError(error)
    }
  }
  if (!page) return null
  return (
    <section
      className="result-gallery"
      aria-label={t('batchResults')}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          select(index + (event.key === 'ArrowLeft' ? -1 : 1))
        }
      }}>
      {pages.length > 1 && (
        <div className="gallery-thumbnails" role="group" aria-label={t('thumbnails')}>
          {pages.map((item, position) => (
            <button
              key={`${item.task.id}:${item.assetId ?? ''}`}
              type="button"
              ref={position === index ? selectedThumbnail : undefined}
              className="gallery-thumbnail"
              aria-current={position === index ? 'true' : undefined}
              aria-label={t('selectResult', {
                index: position + 1,
                model: item.task.modelName || item.task.modelId,
                status: taskStatus(item.task)
              })}
              title={`${item.task.providerName || item.task.providerId} · ${item.task.modelName || item.task.modelId} · ${taskStatus(item.task)}`}
              onClick={() => select(position)}>
              {item.assetId && images[item.assetId] ? (
                <img src={images[item.assetId]} alt="" />
              ) : (
                <span className="thumbnail-placeholder" aria-hidden="true">
                  {item.task.status === 'running' ? '◌' : '▧'}
                </span>
              )}
              <span className="thumbnail-label">
                <span className={`status-dot ${item.task.status}`} />
                {position + 1} · {item.task.modelName || item.task.modelId}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="gallery-toolbar">
        <div className="gallery-source">
          <strong>
            {page.task.providerName || page.task.providerId} · {page.task.modelName || page.task.modelId}
          </strong>
          <small className="muted">{taskStatus(page.task)}</small>
        </div>
        <div className="gallery-navigation" aria-label={t('imageNavigation')} role="group">
          <button
            type="button"
            aria-label={t('previousImage')}
            disabled={index === 0}
            onClick={() => select(index - 1)}>
            ‹
          </button>
          <span className="gallery-counter" aria-live="polite">
            {index + 1} / {pages.length}
          </span>
          <button
            type="button"
            aria-label={t('nextImage')}
            disabled={index === pages.length - 1}
            onClick={() => select(index + 1)}>
            ›
          </button>
        </div>
      </div>
      <div className="gallery-stage" aria-live="polite">
        {data ? (
          <button type="button" className="image-button" onClick={() => onPreview(data)} aria-label={t('preview')}>
            <img src={data} alt={page.task.prompt} />
          </button>
        ) : (
          <div className="empty-preview">
            <div className={page.task.status === 'running' ? 'art-icon spinning' : 'art-icon'}>
              {page.task.status === 'running' ? '◌' : '▧'}
            </div>
            <h2>
              {page.assetId
                ? t(failedImages.has(page.assetId) ? 'imageUnavailable' : 'loading')
                : taskStatus(page.task)}
            </h2>
            <p>{page.task.prompt}</p>
          </div>
        )}
      </div>
      <div className="gallery-actions" role="group" aria-label={t('imageActions')}>
        <button type="button" disabled={!data} onClick={() => void exportImage('save')}>
          {t('save')}
        </button>
        <button type="button" disabled={!data} onClick={() => void exportImage('copy')}>
          {t('copy')}
        </button>
        <button
          type="button"
          disabled={!data}
          onClick={() => {
            if (data) onUseReference(data)
          }}>
          {t('useReference')}
        </button>
      </div>
    </section>
  )
}
