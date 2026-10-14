import { EventEmitter } from 'node:events'
import path from 'node:path'

import { app } from 'electron'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  busy: false,
  quiesce: vi.fn(),
  close: vi.fn(),
  remove: vi.fn(async () => undefined)
}))
vi.mock('../agents/services/opencode/process', () => ({
  hasOpenCodeDataActivity: () => mocks.busy,
  quiesceOpenCodeData: mocks.quiesce
}))
vi.mock('../agents/database/DatabaseManager', () => ({ DatabaseManager: { close: mocks.close } }))
vi.mock('@main/utils/locales', () => ({ t: (key: string) => key }))
vi.mock('fs-extra', () => ({ remove: mocks.remove }))

import { assertAssistantDataAvailable } from '../agents/services/dataOperationGate'
import {
  beginRendererDataOperation,
  endRendererDataOperation,
  markRendererDataCommitted,
  registerRendererDataStage,
  withAssistantDataOperation
} from '../AssistantDataOperationService'

const event = (id: number) => ({ sender: Object.assign(new EventEmitter(), { id, isDestroyed: () => false }) }) as any
describe('main/renderer backup and restore lease', () => {
  it('rejects active work before quiescence or database/file changes', async () => {
    mocks.busy = true
    const work = vi.fn()
    try {
      expect(await beginRendererDataOperation(event(1), 'reset')).toEqual({ success: false, reason: 'busy' })
      await expect(withAssistantDataOperation('backup', work)).rejects.toThrow('assistantDataSafety.busy')
      expect(work).not.toHaveBeenCalled()
      expect(mocks.quiesce).not.toHaveBeenCalled()
      expect(mocks.close).not.toHaveBeenCalled()
    } finally {
      mocks.busy = false
    }
  })
  it('keeps the lock across an owned main restore and ignores another renderer/token', async () => {
    const owner = event(2)
    const admission = await beginRendererDataOperation(owner, 'restore')
    if (!admission.success) throw new Error('admission failed')
    registerRendererDataStage(2, path.join(app.getPath('userData'), 'Data.restore'))
    try {
      await withAssistantDataOperation(
        'restore',
        async () => {
          expect(() => assertAssistantDataAvailable()).toThrow()
        },
        2
      )
      await endRendererDataOperation(event(3), admission.token)
      await endRendererDataOperation(owner, 'wrong-token')
      expect(() => assertAssistantDataAvailable()).toThrow()
    } finally {
      await endRendererDataOperation(owner, admission.token)
    }
    expect(() => assertAssistantDataAvailable()).not.toThrow()
    expect(mocks.remove).toHaveBeenCalledWith(expect.stringContaining('Data.restore'))
  })
  it('preserves committed startup markers and unregisters renderer listeners', async () => {
    mocks.remove.mockClear()
    const owner = event(4)
    const admission = await beginRendererDataOperation(owner, 'reset')
    if (!admission.success) throw new Error('admission failed')
    registerRendererDataStage(4, path.join(app.getPath('userData'), 'Data.restore'))
    markRendererDataCommitted(4)
    await endRendererDataOperation(owner, admission.token)
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(owner.sender.listenerCount('destroyed')).toBe(0)
    expect(() => assertAssistantDataAvailable()).not.toThrow()
  })
  it('releases a failed idle-server preparation without stopping or replaying a task', async () => {
    mocks.quiesce.mockRejectedValueOnce(new Error('stop failed'))
    await expect(beginRendererDataOperation(event(5), 'restore')).rejects.toThrow('stop failed')
    expect(() => assertAssistantDataAvailable()).not.toThrow()
  })
  it('cleans up once when renderer loss and explicit cancellation overlap', async () => {
    const owner = event(6)
    const admission = await beginRendererDataOperation(owner, 'restore')
    if (!admission.success) throw new Error('admission failed')
    mocks.remove.mockClear()
    for (const folder of ['Data', 'IndexedDB', 'Local Storage'])
      registerRendererDataStage(6, path.join(app.getPath('userData'), `${folder}.restore`))
    owner.sender.emit('render-process-gone')
    await Promise.all([
      endRendererDataOperation(owner, admission.token),
      endRendererDataOperation(owner, admission.token)
    ])
    expect(mocks.remove).toHaveBeenCalledTimes(3)
    expect(() => assertAssistantDataAvailable()).not.toThrow()
    const next = await beginRendererDataOperation(owner, 'reset')
    if (!next.success) throw new Error('next admission failed')
    await endRendererDataOperation(owner, admission.token)
    expect(() => assertAssistantDataAvailable()).toThrow()
    await endRendererDataOperation(owner, next.token, true)
  })
  it('retains protection until an in-flight filesystem operation finishes after renderer loss', async () => {
    const owner = event(7)
    const admission = await beginRendererDataOperation(owner, 'restore')
    if (!admission.success) throw new Error('admission failed')
    let complete!: () => void
    const work = withAssistantDataOperation(
      'restore',
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        }),
      7
    )
    owner.sender.emit('destroyed')
    await endRendererDataOperation(owner, admission.token)
    expect(() => assertAssistantDataAvailable()).toThrow()
    complete()
    await work
    expect(() => assertAssistantDataAvailable()).not.toThrow()
  })
  it('releases admission if renderer disappeared during idle-server shutdown', async () => {
    const owner = event(8)
    owner.sender.isDestroyed = () => true
    await expect(beginRendererDataOperation(owner, 'restore')).rejects.toThrow('owner was closed')
    expect(() => assertAssistantDataAvailable()).not.toThrow()
  })
  it('does not delete pre-existing unowned staging and rejects unrelated cleanup targets', async () => {
    mocks.remove.mockClear()
    const owner = event(9)
    const admission = await beginRendererDataOperation(owner, 'reset')
    if (!admission.success) throw new Error('admission failed')
    try {
      expect(() => registerRendererDataStage(9, path.join(app.getPath('userData'), 'Local Storage.restore'))).toThrow()
      expect(() => registerRendererDataStage(9, app.getPath('userData'))).toThrow()
    } finally {
      await endRendererDataOperation(owner, admission.token)
    }
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})
