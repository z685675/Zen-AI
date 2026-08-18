import { throttle } from 'lodash'
import { useCallback, useEffect, useMemo, useRef } from 'react'

import { useTimer } from './useTimer'

/**
 * A custom hook that manages scroll position persistence for a container element
 * @param key - A unique identifier used to store/retrieve the scroll position
 * @returns An object containing:
 *  - containerRef: React ref for the scrollable container
 *  - handleScroll: Throttled scroll event handler that saves scroll position
 *  - restorePosition: Restores a saved position after content has been rendered
 */
export default function useScrollPosition(key: string, throttleWait?: number, shouldRestorePosition = true) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollKey = useMemo(() => `scroll:${key}`, [key])
  const scrollKeyRef = useRef(scrollKey)
  const { setTimeoutTimer } = useTimer()

  useEffect(() => {
    scrollKeyRef.current = scrollKey
  }, [scrollKey])

  const handleScroll = useMemo(
    () =>
      throttle(() => {
        const position = containerRef.current?.scrollTop ?? 0
        window.requestAnimationFrame(() => {
          window.keyv.set(scrollKeyRef.current, position)
        })
      }, throttleWait ?? 100),
    [throttleWait]
  )

  const getStoredPosition = useCallback(() => {
    const rawPosition = window.keyv.get(scrollKeyRef.current)
    const position = typeof rawPosition === 'number' ? rawPosition : Number(rawPosition)

    return Number.isFinite(position) ? position : null
  }, [])

  const restorePosition = useCallback(
    (positionOverride?: number) => {
      const position = positionOverride ?? getStoredPosition()
      if (position === null || position === undefined) return

      containerRef.current?.scrollTo({ top: position })
    },
    [getStoredPosition]
  )

  useEffect(() => {
    if (!shouldRestorePosition) return

    restorePosition()
    setTimeoutTimer('scrollEffect', () => restorePosition(), 50)
  }, [restorePosition, scrollKey, setTimeoutTimer, shouldRestorePosition])

  useEffect(() => {
    return () => handleScroll.cancel()
  }, [handleScroll])

  return { containerRef, handleScroll, getStoredPosition, restorePosition }
}
