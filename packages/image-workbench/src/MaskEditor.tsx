import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function MaskEditor(props: {
  image: string
  onApply: (image: string, mask: string) => void
  onError: (error: unknown) => void
}) {
  const { image: sourceImage, onError } = props
  const { t } = useTranslation()
  const canvas = useRef<HTMLCanvasElement>(null)
  const base = useRef<HTMLImageElement | null>(null)
  const drawing = useRef(false)
  const previous = useRef<{ x: number; y: number } | undefined>(undefined)
  const [brush, setBrush] = useState(60)
  const [ready, setReady] = useState(false)
  const [painted, setPainted] = useState(false)
  useEffect(() => {
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (cancelled || !canvas.current) return
      if (image.naturalWidth * image.naturalHeight > 16_000_000) {
        onError(new Error('invalid_mask'))
        return
      }
      base.current = image
      canvas.current.width = image.naturalWidth
      canvas.current.height = image.naturalHeight
      setReady(true)
    }
    image.onerror = () => onError(new Error('invalid_image'))
    image.src = sourceImage
    return () => {
      cancelled = true
    }
  }, [sourceImage, onError])
  const paint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context || !drawing.current) return
    const bounds = element.getBoundingClientRect()
    const position = {
      x: ((event.clientX - bounds.left) * element.width) / bounds.width,
      y: ((event.clientY - bounds.top) * element.height) / bounds.height
    }
    context.strokeStyle = 'rgba(108,92,231,0.8)'
    context.fillStyle = 'rgba(108,92,231,0.8)'
    context.lineWidth = brush
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.beginPath()
    context.moveTo(previous.current?.x ?? position.x, previous.current?.y ?? position.y)
    context.lineTo(position.x, position.y)
    context.stroke()
    context.beginPath()
    context.arc(position.x, position.y, brush / 2, 0, Math.PI * 2)
    context.fill()
    previous.current = position
    setPainted(true)
  }
  const apply = () => {
    try {
      const layer = canvas.current!
      const mask = document.createElement('canvas')
      mask.width = layer.width
      mask.height = layer.height
      const context = mask.getContext('2d')!
      context.fillStyle = 'white'
      context.fillRect(0, 0, mask.width, mask.height)
      const pixels = layer.getContext('2d')!.getImageData(0, 0, layer.width, layer.height)
      const output = context.getImageData(0, 0, mask.width, mask.height)
      for (let index = 3; index < pixels.data.length; index += 4) if (pixels.data[index]) output.data[index] = 0
      context.putImageData(output, 0, 0)
      const normalized = document.createElement('canvas')
      normalized.width = layer.width
      normalized.height = layer.height
      normalized.getContext('2d')!.drawImage(base.current!, 0, 0)
      props.onApply(normalized.toDataURL('image/png'), mask.toDataURL('image/png'))
    } catch (error) {
      props.onError(error)
    }
  }
  return (
    <>
      <p className="muted">{t('maskHint')}</p>
      <label className="field">
        <span>
          {t('brushSize')} {brush}
        </span>
        <input
          aria-label={t('brushSize')}
          type="range"
          min="8"
          max="240"
          value={brush}
          onChange={(event) => setBrush(Number(event.target.value))}
        />
      </label>
      <div className="mask-stage">
        <img src={props.image} alt={t('references')} />
        <canvas
          ref={canvas}
          aria-label={t('maskEditor')}
          style={{ touchAction: 'none' }}
          onPointerDown={(event) => {
            if (!ready) return
            drawing.current = true
            previous.current = undefined
            event.currentTarget.setPointerCapture(event.pointerId)
            paint(event)
          }}
          onPointerMove={paint}
          onPointerUp={() => {
            drawing.current = false
            previous.current = undefined
          }}
          onPointerCancel={() => {
            drawing.current = false
            previous.current = undefined
          }}
        />
      </div>
      <div className="actions">
        <button
          type="button"
          onClick={() => {
            const element = canvas.current!
            element.getContext('2d')!.clearRect(0, 0, element.width, element.height)
            setPainted(false)
          }}>
          {t('clearMask')}
        </button>
        <button type="button" className="primary" disabled={!ready || !painted} onClick={apply}>
          {t('apply')}
        </button>
      </div>
    </>
  )
}
