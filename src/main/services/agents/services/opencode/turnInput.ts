import { createHash, randomBytes } from 'node:crypto'

import type { AgentInputReceipt, AgentRunInput, AgentRunInputStatus } from '@shared/agents/sessionInput'

import type { OpenCodeClient } from './client'

const turns = new Map<string, OpenCodeTurnInput>()
const receipts = new Map<string, OpenCodeTurnInput>()
const key = (sessionId: string, id: string) => `${sessionId}:${id}`
let lastMessageClock = 0n
export const newOpenCodeMessageId = () => {
  const now = BigInt(Date.now()) * 4096n
  lastMessageClock = now > lastMessageClock ? now : lastMessageClock + 1n
  return `msg_${lastMessageClock.toString(16).padStart(12, '0')}${randomBytes(7).toString('hex')}`
}

/** Admit user additions into the SAME native run. Never start a second adapter
 * or retry an ambiguous POST. Running tools keep their native lifecycle. */
export class OpenCodeTurnInput {
  private open = true
  private accepting = false
  private entries = new Map<string, { hash: string; receipt: AgentInputReceipt; settled: Promise<void> }>()
  private latest: string

  constructor(
    readonly sessionId: string,
    readonly turnId: string,
    private client: Pick<OpenCodeClient, 'request'>,
    private nativeSessionId: string,
    private body: Record<string, unknown>,
    private signal: AbortSignal,
    private observe: (receipt: AgentInputReceipt) => void = () => {}
  ) {
    // Receipts can outlive the run; do not retain the original attachment data.
    this.body = { agent: body.agent, model: body.model, system: body.system }
    this.latest = turnId
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

  get latestMessageId() {
    return this.latest
  }

  get hasAdditions() {
    return this.latest !== this.turnId
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
    if (!this.accepting) return { id: input.id, state: 'rejected', code: 'not_ready' }
    if (this.entries.size >= 50) return { id: input.id, state: 'rejected', code: 'invalid_input' }
    const receipt: AgentInputReceipt = {
      id: input.id,
      state: 'uncertain',
      nativeMessageId: newOpenCodeMessageId(),
      code: 'delivery_uncertain'
    }
    const entry = { hash, receipt, settled: Promise.resolve() }
    this.entries.set(input.id, entry)
    receipts.set(key(this.sessionId, input.id), this)
    while (receipts.size > 300) receipts.delete(receipts.keys().next().value!)
    entry.settled = (async () => {
      try {
        await this.client.request(
          `/session/${this.nativeSessionId}/prompt_async`,
          'POST',
          {
            ...this.body,
            messageID: receipt.nativeMessageId,
            parts: [
              { type: 'text', text: input.text },
              ...(input.images ?? []).map((image) => ({
                type: 'file',
                mime: image.media_type,
                url: `data:${image.media_type};base64,${image.data}`
              }))
            ]
          },
          this.signal
        )
        if (receipt.state === 'uncertain') receipt.state = 'accepted'
        delete receipt.code
        if (receipt.nativeMessageId! > this.latest) this.latest = receipt.nativeMessageId!
      } catch {
        // POST may have reached native storage before the connection failed.
        await this.check(input.id)
      }
      this.observe({ ...receipt })
    })()
    await entry.settled
    return { ...receipt }
  }

  async check(id: string): Promise<AgentInputReceipt> {
    const entry = this.entries.get(id)
    if (!entry) return { id, state: 'rejected', code: 'not_running' }
    if (['applied', 'deferred'].includes(entry.receipt.state)) return { ...entry.receipt }
    try {
      const messages = await this.client.request<Array<{ info: { id: string; parentID?: string; role?: string } }>>(
        `/session/${this.nativeSessionId}/message`
      )
      this.reconcile(messages, !this.open || this.signal.aborted)
    } catch {
      /* Keep ambiguous delivery visible; do not repeat a side effect. */
    }
    return { ...entry.receipt }
  }

  reconcile(messages: Array<{ info: { id: string; parentID?: string; role?: string } }>, finished = false) {
    const ids = new Set(messages.map((message) => message.info.id))
    const delivered = new Set([...this.entries.values()].map((entry) => entry.receipt.nativeMessageId))
    const parents = messages
      .filter((message) => message.info.role === 'assistant' && delivered.has(message.info.parentID))
      .map((message) => message.info.parentID!)
      .sort()
    const latestParent = parents.at(-1)
    for (const entry of this.entries.values()) {
      if (entry.receipt.state === 'applied') continue
      if (!ids.has(entry.receipt.nativeMessageId!)) continue
      entry.receipt.state =
        latestParent && entry.receipt.nativeMessageId! <= latestParent ? 'applied' : finished ? 'deferred' : 'accepted'
      delete entry.receipt.code
      if (entry.receipt.nativeMessageId! > this.latest) this.latest = entry.receipt.nativeMessageId!
    }
  }

  async settle() {
    await Promise.all([...this.entries.values()].map((entry) => entry.settled))
  }

  close() {
    this.open = this.accepting = false
    this.body = {}
    this.observe = () => {}
    if (turns.get(this.sessionId) === this) turns.delete(this.sessionId)
  }
}

export const getAgentRunInputStatus = (sessionId: string): AgentRunInputStatus =>
  turns.get(sessionId)?.status() ?? { active: false, ready: false }

export const submitAgentRunInput = (input: AgentRunInput): Promise<AgentInputReceipt> => {
  const turn = receipts.get(key(input.sessionId, input.id)) ?? turns.get(input.sessionId)
  return turn?.submit(input) ?? Promise.resolve({ id: input.id, state: 'rejected', code: 'not_running' })
}

export const checkAgentRunInput = (sessionId: string, id: string): Promise<AgentInputReceipt> =>
  receipts.get(key(sessionId, id))?.check(id) ??
  Promise.resolve({ id, state: 'uncertain', code: 'receipt_unavailable' })
