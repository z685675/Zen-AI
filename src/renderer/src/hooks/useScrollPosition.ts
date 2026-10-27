import { throttle } from 'lodash'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'

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
  const { setTimeoutTimer } = useTimer()

  const savePosition = useMemo(
    () =>
      throttle((position: number) => {
        window.keyv.set(scrollKey, position)
      }, throttleWait ?? 100),
    [scrollKey, throttleWait]
  )

  const handleScroll = useCallback(() => {
    // Capture both the position and its conversation before a throttled write.
    if (containerRef.current) savePosition(containerRef.current.scrollTop)
  }, [savePosition])

  const getStoredPosition = useCallback(() => {
    const rawPosition = window.keyv.get(scrollKey)
    if (rawPosition === null || rawPosition === undefined || rawPosition === '') return null
    const position = typeof rawPosition === 'number' ? rawPosition : Number(rawPosition)

    return Number.isFinite(position) ? position : null
  }, [scrollKey])

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
    return setTimeoutTimer('scrollEffect', () => restorePosition(), 50)
  }, [restorePosition, scrollKey, setTimeoutTimer, shouldRestorePosition])

  useLayoutEffect(() => {
    return () => {
      // Navigation often happens within the throttle window. Keep the last event.
      savePosition.flush()
      savePosition.cancel()
    }
  }, [savePosition])

  return { containerRef, handleScroll, getStoredPosition, restorePosition }
}
