import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ created: [] as any[], showWindow: vi.fn(), focus: vi.fn(), send: vi.fn() }))
vi.mock('electron', () => ({
  Notification: class {
    listeners = new Map<string, () => void>()
    show = vi.fn()
    constructor(readonly options: unknown) {
      mocks.created.push(this)
    }
    on(event: string, listener: () => void) {
      this.listeners.set(event, listener)
    }
  }
}))
vi.mock('../WindowService', () => ({
  windowService: {
    showMainWindow: mocks.showWindow,
    getMainWindow: () => ({ focus: mocks.focus, webContents: { send: mocks.send } })
  }
}))

import NotificationService from '../NotificationService'

describe('native notification serialization and focus', () => {
  it('retains the serializable target and honors silent without executing any task', async () => {
    const notification = {
      id: 'turn',
      type: 'success',
      source: 'assistant',
      title: 'Zen AI',
      message: 'Task completed',
      silent: true,
      timestamp: 1,
      meta: { assistantTarget: { agentId: 'zen-opencode-default', sessionId: 's' } }
    } as const
    await new NotificationService().sendNotification(notification)
    const native = mocks.created.at(-1)
    expect(native.options).toEqual({ title: 'Zen AI', body: 'Task completed', silent: true })
    expect(native.show).toHaveBeenCalledOnce()
    native.listeners.get('click')!()
    expect(mocks.showWindow).toHaveBeenCalledOnce()
    expect(mocks.focus).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledWith('notification-click', notification)
    expect(JSON.parse(JSON.stringify(mocks.send.mock.calls[0][1])).meta).toEqual(notification.meta)
  })
})
