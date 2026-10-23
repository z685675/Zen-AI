import type { AutomationDelivery } from '../../database/schema'
import type { AutomationRepository } from './AutomationRepository'
import { type AutomationTarget, type DeliveryOutcome, deliveryTarget } from './AutomationRepository'

export interface AutomationTextTransport {
  /** Must describe the actual currently authenticated account, not a configured fallback. */
  readonly accountId: string
  sendFile?: (
    request: {
      target: AutomationTarget
      runId: string
      deliveryKey: string
      path: string
      sha256: string
      size: number
    },
    signal: AbortSignal
  ) => Promise<DeliveryOutcome>
  /** Transport owns localized role labels; never treat a mirrored user message as new input. */
  sendText(
    request: {
      target: AutomationTarget
      runId: string
      deliveryKey: string
      role: AutomationDelivery['role']
      text: string
    },
    signal: AbortSignal
  ): Promise<DeliveryOutcome>
}

function safeOutcome(value: DeliveryOutcome): DeliveryOutcome {
  if (value?.status === 'accepted') return { status: 'accepted' }
  if (
    value &&
    ['retryable', 'failed', 'unknown'].includes(value.status) &&
    'reason' in value &&
    typeof value.reason === 'string' &&
    /^[a-z0-9_.-]{1,64}$/.test(value.reason)
  )
    return value
  return { status: 'unknown', reason: 'invalid_transport_result' }
}

/** One bounded delivery attempt. This class cannot start or retry a model task. */
export class AutomationOutbox {
  constructor(
    private readonly repository: AutomationRepository,
    private readonly timeoutMs = 15_000
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new Error('automation_invalid_delivery_timeout')
  }

  async dispatchNext(channelId: string, transport: AutomationTextTransport, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false
    const delivery = await this.repository.claimDelivery(channelId)
    if (!delivery?.lease) return false
    const settle = (outcome: DeliveryOutcome) => this.repository.settleDelivery(delivery.id, delivery.lease!, outcome)
    if (transport.accountId !== delivery.accountId) {
      await settle({ status: 'failed', reason: 'account_changed' })
      return true
    }
    const target = deliveryTarget(delivery)
    const file = await this.repository.fileForDelivery(delivery.id)
    if (!(await this.repository.isCurrentTarget(target)) || signal?.aborted) {
      await settle({ status: 'failed', reason: 'binding_or_request_cancelled' })
      return true
    }

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const interrupted = new Promise<DeliveryOutcome>((resolve) => {
      const interrupt = (reason: string) => {
        // A submitted request may already have reached WeChat. Cancellation is not proof of failure.
        resolve({ status: 'unknown', reason })
        controller.abort()
      }
      onAbort = () => interrupt('delivery_cancelled')
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => interrupt('delivery_timeout'), this.timeoutMs)
    })
    try {
      const send = Promise.resolve()
        .then((): Promise<DeliveryOutcome> | DeliveryOutcome => {
          if (controller.signal.aborted) return { status: 'failed', reason: 'cancelled_before_send' }
          if (file)
            return transport.sendFile
              ? transport.sendFile(
                  { target, runId: delivery.runId, deliveryKey: delivery.deliveryKey, ...file },
                  controller.signal
                )
              : { status: 'failed', reason: 'files_not_supported' }
          return transport.sendText(
            {
              target,
              runId: delivery.runId,
              deliveryKey: delivery.deliveryKey,
              role: delivery.role,
              text: delivery.text
            },
            controller.signal
          )
        })
        .catch((): DeliveryOutcome => ({ status: 'unknown', reason: 'transport_exception' }))
      await settle(safeOutcome(await Promise.race([send, interrupted])))
      return true
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
  }
}
