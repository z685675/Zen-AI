import path from 'node:path'

import { t } from '@main/utils/locales'
import { app, type IpcMainInvokeEvent } from 'electron'
import * as fs from 'fs-extra'

import { DatabaseManager } from './agents/database/DatabaseManager'
import {
  acquireAssistantDataOperation,
  type AssistantDataOperation,
  ownsAssistantDataOperation
} from './agents/services/dataOperationGate'
import { hasAnySessionActivity } from './agents/services/sessionActivity'

const leases = new Map<
  number,
  {
    token: string
    kind: AssistantDataOperation
    release: () => Promise<void>
    inflight: number
    ending: boolean
    committed: boolean
    stagedPaths: Set<string>
  }
>()

async function acquire(kind: AssistantDataOperation, owner?: number) {
  const runtime = await import('./agents/services/opencode/process')
  // No await between the busy check and reservation; task admission uses the same gate.
  const lease = acquireAssistantDataOperation(
    kind,
    () => hasAnySessionActivity() || runtime.hasOpenCodeDataActivity(),
    owner
  )
  try {
    await runtime.quiesceOpenCodeData()
    if (kind !== 'backup') await DatabaseManager.close()
    return lease
  } catch (error) {
    lease.release()
    throw error
  }
}

export async function withAssistantDataOperation<T>(
  kind: AssistantDataOperation,
  work: () => Promise<T>,
  owner?: number
): Promise<T> {
  const existing = owner === undefined ? undefined : leases.get(owner)
  if (existing && !existing.ending && ownsAssistantDataOperation(kind, owner)) {
    existing.inflight++
    try {
      return await work()
    } finally {
      existing.inflight--
      if (existing.ending && !existing.inflight) await existing.release()
    }
  }
  let lease: Awaited<ReturnType<typeof acquire>> | undefined
  try {
    lease = await acquire(kind, owner)
    return await work()
  } catch (error) {
    if ((error as { code?: string }).code === 'assistant_data_busy') throw new Error(t('assistantDataSafety.busy'))
    throw error
  } finally {
    lease?.release()
  }
}

/** Covers renderer IndexedDB/localStorage mutations as well as the main-process restore. */
export async function beginRendererDataOperation(event: IpcMainInvokeEvent, kind: unknown) {
  if (kind !== 'restore' && kind !== 'reset') throw new Error('Invalid data operation')
  const owner = event.sender.id
  try {
    const lease = await acquire(kind, owner)
    const end = () => {
      const entry = leases.get(owner)
      if (entry?.token !== lease.token) return
      entry.ending = true
      if (!entry.inflight) void entry.release().catch(() => undefined)
    }
    let releasing: Promise<void> | undefined
    const releaseOnce = async () => {
      const entry = leases.get(owner)
      if (entry?.token !== lease.token) return
      try {
        if (!entry.committed) {
          await Promise.all([...entry.stagedPaths].map((staged) => fs.remove(staged)))
        }
      } finally {
        lease.release()
        if (leases.get(owner)?.token === lease.token) leases.delete(owner)
        event.sender.removeListener('destroyed', end)
        event.sender.removeListener('render-process-gone', end)
      }
    }
    const release = () => (releasing ??= releaseOnce())
    leases.set(owner, {
      token: lease.token,
      kind,
      release,
      inflight: 0,
      ending: false,
      committed: false,
      stagedPaths: new Set()
    })
    event.sender.once('destroyed', end)
    event.sender.once('render-process-gone', end)
    if (event.sender.isDestroyed()) {
      await release()
      throw new Error('Data operation owner was closed before preparation completed')
    }
    return { success: true as const, token: lease.token }
  } catch (error) {
    if ((error as { code?: string }).code === 'assistant_data_busy')
      return { success: false as const, reason: 'busy' as const }
    throw error
  }
}

export function markRendererDataCommitted(owner?: number): void {
  if (owner !== undefined) {
    const entry = leases.get(owner)
    if (entry) entry.committed = true
  }
}

/** Only main-process code can register its own staging paths for failure cleanup. */
export function registerRendererDataStage(owner: number | undefined, staged: string): void {
  const entry = owner === undefined ? undefined : leases.get(owner)
  if (!entry) return
  const allowed = entry.kind === 'reset' ? ['Data'] : ['Data', 'IndexedDB', 'Local Storage']
  const resolved = path.resolve(staged)
  if (!allowed.some((folder) => resolved === path.resolve(app.getPath('userData'), `${folder}.restore`)))
    throw new Error('Invalid assistant data staging path')
  entry.stagedPaths.add(resolved)
}

export async function endRendererDataOperation(
  event: IpcMainInvokeEvent,
  token: unknown,
  committed = false
): Promise<void> {
  const entry = leases.get(event.sender.id)
  if (typeof token !== 'string' || entry?.token !== token) return
  entry.ending = true
  entry.committed ||= committed === true
  if (!entry.inflight) await entry.release()
}
