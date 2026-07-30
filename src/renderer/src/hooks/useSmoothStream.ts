import { useCallback, useEffect, useRef } from 'react'

interface UseSmoothStreamOptions {
  onUpdate: (text: string) => void
  streamDone: boolean
  minDelay?: number
  initialText?: string
}

const languages = ['en-US', 'de-DE', 'es-ES', 'zh-CN', 'zh-TW', 'ja-JP', 'ru-RU', 'el-GR', 'fr-FR', 'pt-PT', 'ro-RO']
const segmenter = new Intl.Segmenter(languages)

export const useSmoothStream = ({ onUpdate, streamDone, minDelay = 10, initialText = '' }: UseSmoothStreamOptions) => {
  const chunkQueueRef = useRef<string[]>([])
  const chunkQueueOffsetRef = useRef(0)
  const animationFrameRef = useRef<number | null>(null)
  const displayedTextRef = useRef(initialText)
  const lastUpdateTimeRef = useRef(0)
  const onUpdateRef = useRef(onUpdate)
  const streamDoneRef = useRef(streamDone)
  const minDelayRef = useRef(minDelay)
  const renderLoopRef = useRef<(currentTime: number) => void>(() => {})

  onUpdateRef.current = onUpdate
  streamDoneRef.current = streamDone
  minDelayRef.current = minDelay

  const scheduleRender = useCallback(() => {
    if (animationFrameRef.current !== null) return
    animationFrameRef.current = requestAnimationFrame((currentTime) => renderLoopRef.current(currentTime))
  }, [])

  const addChunk = useCallback(
    (chunk: string) => {
      if (!chunk) return

      for (const segment of segmenter.segment(chunk)) {
        chunkQueueRef.current.push(segment.segment)
      }
      scheduleRender()
    },
    [scheduleRender]
  )

  const reset = useCallback((newText = '') => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    chunkQueueRef.current = []
    chunkQueueOffsetRef.current = 0
    displayedTextRef.current = newText
    onUpdateRef.current(newText)
  }, [])

  renderLoopRef.current = (currentTime: number) => {
    animationFrameRef.current = null

    const queue = chunkQueueRef.current
    const availableCount = queue.length - chunkQueueOffsetRef.current
    if (availableCount <= 0) return

    if (!streamDoneRef.current && currentTime - lastUpdateTimeRef.current < minDelayRef.current) {
      scheduleRender()
      return
    }
    lastUpdateTimeRef.current = currentTime

    const charsToRenderCount = streamDoneRef.current ? availableCount : Math.max(1, Math.floor(availableCount / 5))
    const startIndex = chunkQueueOffsetRef.current
    const endIndex = startIndex + charsToRenderCount
    displayedTextRef.current += queue.slice(startIndex, endIndex).join('')
    chunkQueueOffsetRef.current = endIndex
    onUpdateRef.current(displayedTextRef.current)

    if (chunkQueueOffsetRef.current >= queue.length) {
      chunkQueueRef.current = []
      chunkQueueOffsetRef.current = 0
      return
    }

    if (chunkQueueOffsetRef.current >= 4096 && chunkQueueOffsetRef.current * 2 >= queue.length) {
      chunkQueueRef.current = queue.slice(chunkQueueOffsetRef.current)
      chunkQueueOffsetRef.current = 0
    }
    scheduleRender()
  }

  useEffect(() => {
    if (streamDone && chunkQueueRef.current.length > chunkQueueOffsetRef.current) {
      scheduleRender()
    }
  }, [scheduleRender, streamDone])

  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [])

  return { addChunk, reset }
}
