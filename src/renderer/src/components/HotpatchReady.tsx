import { loggerService } from '@logger'
import db from '@renderer/databases'
import { persistor } from '@renderer/store'
import { useEffect } from 'react'

const logger = loggerService.withContext('HotpatchReady')

/** Mount inside PersistGate. Read existing DB schema only, without changing data or calling a model. */
export function HotpatchReady({ onReady }: { onReady: () => void }) {
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const challenge = await window.api.hotpatch.startup()
        if (!persistor.getState().bootstrapped) return
        if (!challenge) {
          if (alive) onReady()
          return
        }
        await db.open()
        await db.transaction('r', db.topics, db.settings, async () => {
          await db.topics.limit(1).count()
          await db.settings.limit(1).count()
        })
        // A launch-to-tray window may not receive animation frames. Local readiness must not
        // quarantine a good patch simply because the window is hidden.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250)
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              clearTimeout(timer)
              resolve()
            })
          )
        })
        if (alive && (await window.api.hotpatch.healthy(challenge))) onReady()
      } catch {
        logger.warn('Local startup readiness was not confirmed')
      }
    })()
    return () => {
      alive = false
    }
  }, [onReady])
  return null
}
