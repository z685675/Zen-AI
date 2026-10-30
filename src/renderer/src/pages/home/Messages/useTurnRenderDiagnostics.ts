import { getDiagnosticEvidence, recordDiagnostic } from '@renderer/services/DiagnosticEvidenceService'
import type { Message } from '@renderer/types/newMessage'
import { isMessageProcessing } from '@renderer/utils/messageUtils/is'
import { findLiveRenderCommit, LIVE_RENDER_MEASUREMENT } from '@shared/turnRenderTiming'
import { type RefObject, useLayoutEffect, useRef } from 'react'

function isVisible(root: HTMLElement | null) {
  if (!root?.isConnected || document.visibilityState !== 'visible') return false
  for (let element: HTMLElement | null = root; element; element = element.parentElement) {
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false
    const style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  }
  return true
}

/** Measure only a live terminal transition observed by this continuously visible mount. */
export function useTurnRenderDiagnostics(message: Message, root: RefObject<HTMLDivElement | null>) {
  const observation = useRef<{ messageId: string; operationId: string; at: string } | undefined>(undefined)
  const { id, role, status } = message
  const finishedAt = message.providerMetadata?.responseTiming?.finishedAt
  const processing = isMessageProcessing(message)

  useLayoutEffect(() => {
    const previous = observation.current
    observation.current = undefined
    if (role !== 'assistant' || !isVisible(root.current)) return undefined
    const evidence = getDiagnosticEvidence(id)
    const operationId = evidence?.metadata.runtimeOperationId
    if (!evidence || typeof operationId !== 'string' || !Number.isFinite(Date.parse(evidence.startedAt)))
      return undefined

    if (processing) {
      observation.current =
        previous?.messageId === id && previous.operationId === operationId
          ? previous
          : { messageId: id, operationId, at: new Date().toISOString() }
      const invalidate = () => {
        observation.current = undefined
      }
      const onVisibilityChange = () => {
        if (!isVisible(root.current)) invalidate()
      }
      const observer = new MutationObserver(onVisibilityChange)
      for (let element: HTMLElement | null = root.current; element; element = element.parentElement) {
        observer.observe(element, { attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'style', 'class'] })
      }
      document.addEventListener('visibilitychange', onVisibilityChange)
      window.addEventListener('pagehide', invalidate)
      return () => {
        observer.disconnect()
        document.removeEventListener('visibilitychange', onVisibilityChange)
        window.removeEventListener('pagehide', invalidate)
      }
    }

    if (
      (status !== 'success' && status !== 'error' && status !== 'paused') ||
      previous?.messageId !== id ||
      previous.operationId !== operationId ||
      !finishedAt ||
      !Number.isFinite(Date.parse(finishedAt)) ||
      Date.parse(previous.at) < Date.parse(evidence.startedAt) ||
      Date.parse(previous.at) > Date.parse(finishedAt) ||
      findLiveRenderCommit(evidence.events, evidence.startedAt, finishedAt)
    ) {
      return undefined
    }
    recordDiagnostic(id, 'ui', 'render-committed', {
      status,
      measurement: LIVE_RENDER_MEASUREMENT,
      observedActiveAt: previous.at,
      responseFinishedAt: finishedAt
    })
    return undefined
  }, [finishedAt, id, processing, role, root, status])
}
