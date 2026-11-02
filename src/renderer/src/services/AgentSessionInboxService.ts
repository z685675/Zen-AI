import { loggerService } from '@logger'
import store from '@renderer/store'
import { upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import { saveMessageAndBlocksToDB, sendMessage } from '@renderer/store/thunk/messageThunk'
import type { FileMetadata, Message } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { hasTopicPendingRequests, waitForTopicQueue } from '@renderer/utils/queue'
import type { AgentInputReceipt } from '@shared/agents/sessionInput'
import type { AgentRunInputStatus } from '@shared/agents/sessionInput'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'

import FileManager from './FileManager'

const logger = loggerService.withContext('AgentSessionInbox')
const STORAGE_KEY = 'agent-session-inbox:v1'
type SendArguments = Parameters<typeof sendMessage>
export type AgentInboxPayload = {
  args: SendArguments
  text: string
  files: FileMetadata[]
  workspace?: string
}
export type AgentInboxEntry = AgentInboxPayload & {
  id: string
  sessionId: string
  delivery: 'queue' | 'steer'
  state: 'queued' | 'sending' | 'sent' | 'failed' | AgentInputReceipt['state']
  receipt?: AgentInputReceipt
}

export type InboxDependencies = {
  read: () => AgentInboxEntry[]
  write: (entries: AgentInboxEntry[]) => void
  busy: (entry: AgentInboxEntry) => boolean
  failed: (entry: AgentInboxEntry) => string | undefined
  send: (entry: AgentInboxEntry) => Promise<void>
  steer: (entry: AgentInboxEntry) => Promise<AgentInputReceipt>
  check: (entry: AgentInboxEntry) => Promise<AgentInputReceipt>
  status: (sessionId: string) => Promise<AgentRunInputStatus>
  accepted: (entry: AgentInboxEntry) => Promise<void>
}

/** A durable client outbox, not an agent execution loop. Every queued item
 * uses the existing normal send pipeline exactly once. Never replay on load. */
export class AgentSessionInbox {
  private entries: AgentInboxEntry[]
  private listeners = new Set<() => void>()
  private paused = new Set<string>()
  private processing = new Set<string>()
  private checking = new Set<string>()
  private ignoredFailure = new Map<string, string | undefined>()
  private timer?: ReturnType<typeof setInterval>

  constructor(private deps: InboxDependencies) {
    this.entries = deps
      .read()
      .map((entry) => ({ ...entry, state: ['sending', 'accepted'].includes(entry.state) ? 'uncertain' : entry.state }))
    for (const entry of this.entries) this.paused.add(entry.sessionId)
  }

  snapshot = () => this.entries
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  isPaused(sessionId: string) {
    return this.paused.has(sessionId)
  }

  private publish(strict = false) {
    this.entries = [...this.entries]
    try {
      this.deps.write(this.entries)
    } catch (error) {
      if (strict) throw error
      logger.warn('Could not persist the assistant outbox', { error })
    }
    for (const listener of this.listeners) listener()
  }

  add(payload: AgentInboxPayload, delivery: 'queue' | 'steer') {
    const context = payload.args[4]
    this.entries = this.entries.filter((entry) => !['sent', 'applied'].includes(entry.state))
    if (!context || context.agentId !== DEFAULT_OPENCODE_AGENT_ID || this.entries.length >= 50)
      throw new Error('Assistant outbox is full or missing its session')
    const entry: AgentInboxEntry = {
      ...payload,
      id: payload.args[0].id,
      sessionId: context.sessionId,
      delivery,
      state: delivery === 'queue' ? 'queued' : 'sending'
    }
    this.entries = [...this.entries, entry]
    try {
      this.publish(true)
    } catch (error) {
      this.entries = this.entries.filter((item) => item !== entry)
      throw error
    }
    if (delivery === 'steer') void this.deliver(entry)
    this.schedule()
  }

  private schedule() {
    if (this.timer) return
    this.timer = setInterval(() => void this.flush(), 750)
  }

  pause(sessionId: string) {
    this.paused.add(sessionId)
    this.publish()
  }
  resume(sessionId: string) {
    const entry = this.entries.find((item) => item.sessionId === sessionId)
    if (entry) this.ignoredFailure.set(sessionId, this.deps.failed(entry))
    this.paused.delete(sessionId)
    this.publish()
    this.schedule()
    void this.flush()
  }
  remove(id: string): AgentInboxEntry | undefined {
    const entry = this.entries.find((item) => item.id === id)
    if (!entry || entry.state === 'sending') return
    this.entries = this.entries.filter((item) => item.id !== id)
    this.publish()
    return entry
  }
  async check(id: string) {
    const entry = this.entries.find((item) => item.id === id)
    if (!entry || entry.delivery !== 'steer' || this.checking.has(id)) return
    this.checking.add(id)
    try {
      entry.receipt = await this.deps.check(entry)
      entry.state = entry.receipt.state
      if (['accepted', 'applied', 'deferred'].includes(entry.state)) await this.deps.accepted(entry)
    } catch {
      entry.state = 'uncertain'
    } finally {
      this.checking.delete(id)
    }
    this.publish()
  }
  private async deliver(entry: AgentInboxEntry) {
    try {
      entry.receipt = await this.deps.steer(entry)
      entry.state = entry.receipt.state
      if (['accepted', 'applied', 'deferred'].includes(entry.state)) await this.deps.accepted(entry)
    } catch {
      entry.state = 'uncertain'
    }
    this.publish()
  }
  async flush() {
    for (const sessionId of new Set(
      this.entries.filter((entry) => entry.state === 'queued').map((entry) => entry.sessionId)
    )) {
      if (this.paused.has(sessionId) || this.processing.has(sessionId)) continue
      const entry = this.entries.find((item) => item.sessionId === sessionId && item.state === 'queued')!
      if (this.deps.busy(entry)) continue
      const failure = this.deps.failed(entry)
      if (failure && failure !== this.ignoredFailure.get(sessionId)) {
        this.pause(sessionId)
        continue
      }
      this.processing.add(sessionId)
      try {
        const status = await this.deps.status(sessionId)
        if (status.active || this.paused.has(sessionId) || !this.entries.includes(entry)) continue
        entry.state = 'sending'
        // Persist BEFORE the model request: a crash must never restore an
        // already dispatched item as safely queued for automatic replay.
        this.publish(true)
        await this.deps.send(entry)
        entry.state = 'sent'
      } catch {
        entry.state = 'failed'
        this.paused.add(sessionId)
      } finally {
        this.processing.delete(sessionId)
        this.publish()
      }
    }
    // Finish accepted receipts after the run settles, without submitting again.
    for (const entry of this.entries.filter((item) => item.state === 'accepted' && !this.deps.busy(item)))
      await this.check(entry.id)
    if (!this.entries.some((entry) => ['queued', 'sending', 'accepted'].includes(entry.state))) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}

let inbox: AgentSessionInbox | undefined
export function getAgentSessionInbox() {
  if (inbox) return inbox
  inbox = new AgentSessionInbox({
    read: () => {
      try {
        const data: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
        return Array.isArray(data)
          ? data
              .filter(
                (entry) =>
                  entry &&
                  typeof entry.id === 'string' &&
                  typeof entry.sessionId === 'string' &&
                  typeof entry.text === 'string' &&
                  ['queue', 'steer'].includes(entry.delivery) &&
                  [
                    'queued',
                    'sending',
                    'sent',
                    'failed',
                    'accepted',
                    'applied',
                    'deferred',
                    'uncertain',
                    'rejected'
                  ].includes(entry.state) &&
                  Array.isArray(entry.files) &&
                  entry.files.every(
                    (file) =>
                      file &&
                      typeof file.id === 'string' &&
                      typeof file.ext === 'string' &&
                      typeof file.origin_name === 'string'
                  ) &&
                  Array.isArray(entry.args) &&
                  entry.args[0]?.id === entry.id &&
                  Array.isArray(entry.args[1]) &&
                  entry.args[2] &&
                  typeof entry.args[3] === 'string' &&
                  entry.args[4]?.sessionId === entry.sessionId &&
                  entry.args[4]?.agentId === DEFAULT_OPENCODE_AGENT_ID
              )
              .slice(-50)
          : []
      } catch {
        return []
      }
    },
    write: (entries) => localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)),
    status: (sessionId) => window.api.agentSessionStream.inputStatus(sessionId),
    busy: (entry) =>
      !!store.getState().messages.loadingByTopic[entry.args[3]] || hasTopicPendingRequests(entry.args[3]),
    failed: (entry) => {
      const latest = selectMessagesForTopic(store.getState(), entry.args[3])
        .filter((message) => message.role === 'assistant')
        .at(-1)
      return latest && ['error', 'paused'].includes(latest.status) ? latest.id : undefined
    },
    send: async (entry) => {
      await store.dispatch(sendMessage(...entry.args))
      await waitForTopicQueue(entry.args[3])
      const answer = selectMessagesForTopic(store.getState(), entry.args[3]).find(
        (message) => message.askId === entry.id
      )
      if (!answer || answer.status !== 'success') throw new Error('Queued assistant task did not complete')
    },
    steer: async (entry) => {
      const current = await window.api.agentSessionStream.inputStatus(entry.sessionId)
      if (!current.active || !current.ready || !current.turnId)
        return { id: entry.id, state: 'rejected', code: current.active ? 'not_ready' : 'not_running' }
      const paths: string[] = []
      const images: Array<{ data: string; media_type: string }> = []
      for (const [index, file] of entry.files.entries()) {
        if (!entry.workspace) throw new Error('Missing attachment workspace')
        const name = `${index + 1}-${file.origin_name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')}`
        paths.push(
          await window.api.file.copyToAgentAttachment(
            `${file.id}${file.ext}`,
            entry.workspace,
            entry.sessionId,
            entry.id,
            name
          )
        )
        if (file.type === FILE_TYPE.IMAGE) {
          const mime =
            file.ext.toLowerCase() === '.jpg' || file.ext.toLowerCase() === '.jpeg'
              ? 'image/jpeg'
              : `image/${file.ext.slice(1).toLowerCase()}`
          images.push({ data: (await FileManager.readBase64File(file)).replace(/^data:[^,]+,/, ''), media_type: mime })
        }
      }
      return window.api.agentSessionStream.submitInput({
        sessionId: entry.sessionId,
        turnId: current.turnId,
        id: entry.id,
        text: [entry.text, paths.length ? `[Attached files saved to the workspace]\n${paths.join('\n')}` : '']
          .filter(Boolean)
          .join('\n\n'),
        images
      })
    },
    check: (entry) => window.api.agentSessionStream.checkInput(entry.sessionId, entry.id),
    accepted: async (entry) => {
      const [message, blocks, , topicId] = entry.args
      const updated: Message = {
        ...message,
        providerMetadata: {
          ...message.providerMetadata,
          agentInput: { delivery: 'steer', state: entry.state },
          opencode: { user_message_id: entry.receipt?.nativeMessageId }
        }
      }
      await saveMessageAndBlocksToDB(topicId, updated, blocks)
      if (store.getState().messages.entities[updated.id])
        store.dispatch(newMessagesActions.updateMessage({ topicId, messageId: updated.id, updates: updated }))
      else store.dispatch(newMessagesActions.addMessage({ topicId, message: updated }))
      store.dispatch(upsertManyBlocks(blocks))
    }
  })
  return inbox
}
