import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { loggerService } from '@logger'
import { type CSSProperties, type RefObject, useLayoutEffect, useState } from 'react'

const logger = loggerService.withContext('QuickPanelPosition')

export function useAnchoredPanel(
  anchor: HTMLElement | undefined,
  floatingRef: RefObject<HTMLDivElement | null>,
  visible: boolean,
  close: (action: string) => void
): CSSProperties | undefined {
  const [position, setPosition] = useState<{ anchor: HTMLElement; x: number; y: number }>()

  useLayoutEffect(() => {
    setPosition(undefined)
    const floating = floatingRef.current
    if (!visible || !anchor || !floating) return
    let active = true

    const update = () => {
      if (!anchor.isConnected) {
        close('anchor-removed')
        return
      }
      void computePosition(anchor, floating, {
        strategy: 'fixed',
        placement: 'top-start',
        middleware: [
          offset(8),
          flip({ padding: 8 }),
          shift({ padding: 8 }),
          size({
            padding: 8,
            apply({ availableHeight }) {
              if (active) floating.style.setProperty('--quick-panel-max-height', `${Math.max(0, availableHeight)}px`)
            }
          })
        ]
      })
        .then(({ x, y }) => {
          if (active) setPosition({ anchor, x, y })
        })
        .catch((error) => {
          if (!active) return
          logger.warn('Unable to position anchored quick panel', error as Error)
          close('position-error')
        })
    }

    // Track actual button movement as the editor grows or toolbar wraps, as
    // well as ancestor scrolling, resizing and desktop zoom changes.
    const cleanup = autoUpdate(anchor, floating, update, { animationFrame: true })
    return () => {
      active = false
      cleanup()
    }
  }, [anchor, close, floatingRef, visible])

  if (!anchor) return undefined
  return position?.anchor === anchor ? { left: position.x, top: position.y } : { visibility: 'hidden' }
}
