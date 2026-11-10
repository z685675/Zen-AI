import { createHash, randomUUID } from 'node:crypto'

import type { AgentInputReceipt, AgentRunInput, AgentRunInputStatus } from '@shared/agents/sessionInput'

import type { DshEvent, DshHistory, DshRuntime } from '../../../dshPreview/runtime'

const turns = new Map<string, DshTurnInput>()
const receipts = new Map<string, DshTurnInput>()
const receiptKey = (sessionId: string, id: string) => `${sessionId}:${id}`

export class DshTurnInput {
  readonly turnId = `dsh-turn-${randomUUID()}`
  private open = true
  private accepting = false
  private runtime: Pick<DshRuntime, 'call' | 'snapshot'> | undefined
  private entries = new Map<string, { hash: string; receipt: AgentInputReceipt; settled: Promise<void> }>()

  constructor(
    readonly sessionId: string,
    runtime: Pick<DshRuntime, 'call' | 'snapshot'>,
    private signal: AbortSignal
  ) {
    this.runtime = runtime
    turns.set(sessionId, this)
  }

  status(): AgentRunInputStatus {
    return {
      active: this.open && !this.signal.aborted,
      ready: this.open && this.accepting && !this.signal.aborted,
      turnId: this.turnId
    }
  }

  ready(value: boolean) {
    this.accepting = value
  }

  async submit(input: AgentRunInput): Promise<AgentInputReceipt> {
    const hash = createHash('sha256')
      .update(JSON.stringify([input.text, input.images]))
      .digest('hex')
    const existing = this.entries.get(input.id)
    if (existing) {
      if (existing.hash !== hash) return { id: input.id, state: 'rejected', code: 'invalid_input' }
      await existing.settled
      return { ...existing.receipt }
    }
    if (input.turnId !== this.turnId || !this.status().active)
      return { id: input.id, state: 'rejected', code: 'not_running' }
    if (!this.accepting || !this.runtime) return { id: input.id, state: 'rejected', code: 'not_ready' }
    if (this.entries.size >= 50 || !input.text.trim() || input.text.length > 1000000)
      return { id: input.id, state: 'rejected', code: 'invalid_input' }
    const nativeMessageId = `zen-input-${createHash('sha256').update(`${this.sessionId}\0${input.id}`).digest('hex').slice(0, 32)}`
    const receipt: AgentInputReceipt = { id: input.id, state: 'uncertain', nativeMessageId, code: 'delivery_uncertain' }
    const entry = { hash, receipt, settled: Promise.resolve() }
    const runtime = this.runtime
    this.entries.set(input.id, entry)
    receipts.set(receiptKey(this.sessionId, input.id), this)
    while (receipts.size > 300) receipts.delete(receipts.keys().next().value!)
    entry.settled = (async () => {
      try {
        await runtime.call('session/steer', { text: input.text, images: input.images, messageId: nativeMessageId })
        if (receipt.state === 'uncertain') receipt.state = 'accepted'
        delete receipt.code
      } catch {
        /* Ambiguous admission is reconciled from native events; never resend it. */
      }
      this.reconcile(runtime.snapshot(), !this.open || this.signal.aborted)
    })()
    await entry.settled
    return { ...receipt }
  }

  observe(event: DshEvent) {
    if (this.entries.size && this.runtime && event.method === 'session.event')
      this.reconcile(this.runtime.snapshot(), false)
  }

  reconcile(history: DshHistory, finished: boolean) {
    for (const entry of this.entries.values()) {
      if (entry.receipt.state === 'applied') continue
      const id = entry.receipt.nativeMessageId
      const delivered = history.events.find((event) => event?.type === 'user/message' && event.data.id === id)
      const inserted = history.events.some(
        (event) =>
          event?.type === 'agent/inbox/spliced' && event.data.inserted?.some((message: any) => message.id === id)
      )
      const processed =
        delivered && history.events.some((event) => event?.type === 'assistant/message' && event.seq > delivered.seq)
      if (processed) entry.receipt.state = 'applied'
      else if (delivered || inserted) entry.receipt.state = finished ? 'deferred' : 'accepted'
      if (delivered || inserted) delete entry.receipt.code
    }
  }

  async check(id: string): Promise<AgentInputReceipt> {
    const entry = this.entries.get(id)
    if (!entry) return { id, state: 'uncertain', code: 'receipt_unavailable' }
    await entry.settled
    if (this.runtime) this.reconcile(this.runtime.snapshot(), !this.open || this.signal.aborted)
    return { ...entry.receipt }
  }

  async close() {
    this.open = this.accepting = false
    await Promise.all([...this.entries.values()].map((entry) => entry.settled))
    if (this.runtime) this.reconcile(this.runtime.snapshot(), true)
    this.runtime = undefined
    if (turns.get(this.sessionId) === this) turns.delete(this.sessionId)
  }
}

export const getDshRunInputStatus = (sessionId: string): AgentRunInputStatus =>
  turns.get(sessionId)?.status() ?? { active: false, ready: false }
export const ownsDshRunInput = (sessionId: string): boolean =>
  turns.has(sessionId) || [...receipts.keys()].some((key) => key.startsWith(`${sessionId}:`))
export const submitDshRunInput = (input: AgentRunInput): Promise<AgentInputReceipt> =>
  (receipts.get(receiptKey(input.sessionId, input.id)) ?? turns.get(input.sessionId))?.submit(input) ??
  Promise.resolve({ id: input.id, state: 'rejected', code: 'not_running' })
export const checkDshRunInput = (sessionId: string, id: string): Promise<AgentInputReceipt> =>
  receipts.get(receiptKey(sessionId, id))?.check(id) ??
  Promise.resolve({ id, state: 'uncertain', code: 'receipt_unavailable' })
