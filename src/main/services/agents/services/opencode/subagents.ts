import {
  OPENCODE_SUBAGENT_CONCURRENCY,
  OPENCODE_SUBAGENT_TURN_LIMIT,
  type OpenCodeSubagentProgress
} from '@shared/agents/opencodeSubagents'

import type { OpenCodeClient, OpenCodeEvent } from './client'
import { OpenCodeStreamState } from './transform'

/** Per-turn admission and observations; the native Task tool still executes children. */
export class OpenCodeSubagents {
  private entries = new Map<string, OpenCodeSubagentProgress>()
  private children = new Map<string, { call: string; state: OpenCodeStreamState }>()
  private active = new Set<string>()
  private waiting = new Map<string, () => void>()
  private backgroundCalls = new Map<string, Set<string>>()
  private seenBackgroundResults = new Set<string>()
  private backgroundResult?: string
  private closed = false
  private startedAt = Date.now()

  constructor(
    private client: Pick<OpenCodeClient, 'request'>,
    readonly root: string,
    private zenId: string,
    private signal: AbortSignal,
    private publish: (items: OpenCodeSubagentProgress[]) => void
  ) {}

  private changed() {
    this.publish([...this.entries.values()].map((item) => ({ ...item })))
  }

  async admit(call: string, description: string, agent: string): Promise<boolean> {
    if (this.closed || this.signal.aborted || !['general', 'explore'].includes(agent)) return false
    if (this.entries.has(call)) return this.active.has(call)
    if (this.entries.size >= OPENCODE_SUBAGENT_TURN_LIMIT) return false
    this.entries.set(call, { id: call, description: description.slice(0, 500), agent, status: 'queued', toolCalls: 0 })
    this.changed()
    if (this.active.size >= OPENCODE_SUBAGENT_CONCURRENCY) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          this.signal.removeEventListener('abort', finish)
          this.waiting.delete(call)
          resolve()
        }
        this.waiting.set(call, finish)
        this.signal.addEventListener('abort', finish, { once: true })
        if (this.signal.aborted || this.closed) finish()
      })
    }
    if (
      this.closed ||
      this.signal.aborted ||
      ['completed', 'failed', 'cancelled'].includes(this.entries.get(call)?.status ?? '')
    )
      return false
    this.active.add(call)
    this.entries.get(call)!.status = 'running'
    this.changed()
    return true
  }

  toolCallPrefix(nativeSession: string) {
    return nativeSession === this.root ? this.zenId : `${this.zenId}:child:${nativeSession}`
  }

  async owns(id: string): Promise<boolean> {
    if (id === this.root) return true
    if (this.children.has(id)) return true
    if (this.closed || this.signal.aborted || typeof id !== 'string' || !id || id.length > 256) return false
    const info = await this.client
      .request<{ id: string; parentID?: string; time?: { created?: number } }>(
        `/session/${encodeURIComponent(id)}`,
        'GET',
        undefined,
        this.signal
      )
      .catch(() => undefined)
    // Only direct children of this run, never another conversation or arbitrary descendants.
    if (info?.id !== id || info.parentID !== this.root || this.children.size >= OPENCODE_SUBAGENT_TURN_LIMIT)
      return false
    this.children.set(id, { call: '', state: new OpenCodeStreamState(id, this.toolCallPrefix(id), new Set()) })
    return true
  }

  async observeParent(part: any) {
    if (part?.type === 'text' && part.synthetic === true && typeof part.messageID === 'string') {
      const match =
        /^<task id="(ses_[\w-]+)" state="(completed|error)">\s*<summary>Background task (?:completed|failed):/.exec(
          typeof part.text === 'string' ? part.text : ''
        )
      const calls = match && this.backgroundCalls.get(match[1])
      if (match && calls?.size && !this.seenBackgroundResults.has(part.messageID)) {
        this.seenBackgroundResults.add(part.messageID)
        if (!this.backgroundResult || this.backgroundResult < part.messageID) this.backgroundResult = part.messageID
        this.backgroundCalls.delete(match[1])
        for (const call of calls) {
          this.finish(call, match[2] === 'error' ? 'failed' : 'completed')
        }
      }
      return
    }
    if (part?.type !== 'tool' || part.tool !== 'task' || typeof part.callID !== 'string') return
    const call = `${this.zenId}:${part.callID}`
    const entry = this.entries.get(call)
    const child = part.state?.metadata?.sessionId
    if (entry && typeof child === 'string' && (await this.owns(child))) {
      this.children.get(child)!.call = call
      if (part.state.metadata.background === true && part.state.status !== 'error') {
        if (!this.active.has(call)) return
        const calls = this.backgroundCalls.get(child) ?? new Set<string>()
        calls.add(call)
        this.backgroundCalls.set(child, calls)
        if (!entry.background) {
          entry.background = true
          this.changed()
        }
        // The Task tool returns "started" before the child actually finishes.
        return
      }
    }
    if (['completed', 'error'].includes(part.state?.status))
      this.finish(call, part.state.status === 'error' ? 'failed' : 'completed')
  }

  get latestBackgroundResult() {
    return this.backgroundResult
  }

  async cancelBackground() {
    const pending = [...this.backgroundCalls].filter(([, calls]) => [...calls].some((call) => this.active.has(call)))
    await Promise.all(
      pending.map(([id]) =>
        this.client.request(`/session/${encodeURIComponent(id)}/abort`, 'POST', {}, this.signal).catch(() => undefined)
      )
    )
  }

  finish(call: string, status: 'completed' | 'failed' | 'cancelled') {
    const entry = this.entries.get(call)
    if (!entry || ['completed', 'failed', 'cancelled'].includes(entry.status)) return
    entry.status = status
    const released = this.active.delete(call)
    this.waiting.get(call)?.()
    // Wake one queued admission. Its continuation reserves the free slot.
    const next = this.waiting.entries().next().value
    if (released && next && !this.closed) {
      this.active.add(next[0])
      next[1]()
    }
    this.changed()
  }

  waitingFor(session: string, status: 'waiting_permission' | 'waiting_answer' | 'running') {
    const child = this.children.get(session)
    const entry = child && this.entries.get(child.call)
    if (entry && !['completed', 'failed', 'cancelled'].includes(entry.status)) {
      entry.status = status
      this.changed()
    }
  }

  child(event: OpenCodeEvent, id: string) {
    const child = this.children.get(id)
    if (!child) return []
    const chunks = child.state.consume(event)
    const entry = this.entries.get(child.call)
    for (const chunk of chunks)
      if (entry && chunk.type === 'tool-call') {
        entry.toolCalls++
        entry.lastTool = chunk.toolName.slice(0, 256)
        this.changed()
      }
    // Child prose remains in native history; only its tools enter the activity log.
    return chunks
  }

  async reconcile() {
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(3000)])
    const recovered = await Promise.all(
      [...this.children.keys()].map(async (id) => {
        const history = await this.client
          .request<Array<{ info: any; parts: any[] }>>(
            `/session/${encodeURIComponent(id)}/message`,
            'GET',
            undefined,
            signal
          )
          .catch(() => [])
        const chunks: ReturnType<OpenCodeStreamState['consume']> = []
        if (!Array.isArray(history)) return chunks
        for (const entry of history) {
          // A resumed child can retain old history. Only this turn's messages count.
          if (entry.info.time?.created !== undefined && entry.info.time.created < this.startedAt) continue
          this.child({ type: 'message.updated', properties: { info: entry.info } }, id)
          for (const part of entry.parts)
            chunks.push(...this.child({ type: 'message.part.updated', properties: { part } }, id))
        }
        // Restore missed activity/results and question answers without appending
        // the child's private prose to the parent's final answer.
        return chunks.filter((chunk) => ['tool-call', 'tool-result', 'tool-error'].includes(chunk.type))
      })
    )
    return recovered.flat()
  }

  usages() {
    return [...this.children.values()].map((child) => child.state.usage())
  }
  get unfinished() {
    return [...this.entries.values()].some((entry) =>
      ['queued', 'running', 'waiting_permission', 'waiting_answer'].includes(entry.status)
    )
  }
  cancelCurrent() {
    this.backgroundCalls.clear()
    for (const entry of this.entries.values()) {
      if (!['completed', 'failed', 'cancelled'].includes(entry.status)) entry.status = 'cancelled'
    }
    this.active.clear()
    for (const wake of [...this.waiting.values()]) wake()
    this.changed()
  }
  close(status: 'failed' | 'cancelled' = 'cancelled') {
    this.closed = true
    for (const call of this.entries.keys()) this.finish(call, status)
    for (const wake of [...this.waiting.values()]) wake()
  }
}
