import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ send: vi.fn(), enabled: true, focused: false, active: 'current' }))
vi.mock('@renderer/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      settings: { notification: { assistant: mocks.enabled } },
      runtime: {
        chat: { activeAgentId: 'zen-opencode-default', activeSessionIdMap: { 'zen-opencode-default': mocks.active } }
      },
      messages: { entities: { reply: { assistantId: 'zen-opencode-default', topicId: 'agent-session:current' } } }
    })
  }
}))
vi.mock('../NotificationService', () => ({ NotificationService: { getInstance: () => ({ send: mocks.send }) } }))

import {
  ASSISTANT_NOTIFICATION_OPEN,
  notifyAssistantTask,
  openAssistantNotification,
  permissionNotificationTarget,
  readAssistantNotificationTarget
} from '../AssistantNotificationService'

beforeEach(() => {
  mocks.send.mockClear()
  mocks.enabled = true
  mocks.focused = false
  mocks.active = 'current'
  vi.spyOn(document, 'hasFocus').mockImplementation(() => mocks.focused)
  window.location.hash = '#/new-assistant'
})
const target = { agentId: DEFAULT_OPENCODE_AGENT_ID, sessionId: 'current' }
describe('private targeted assistant notifications', () => {
  it('deduplicates repeated terminal events but not different outcomes or tasks', async () => {
    await notifyAssistantTask(target, 'dedup', 'success')
    await notifyAssistantTask(target, 'dedup', 'success')
    await notifyAssistantTask(target, 'dedup', 'error')
    await notifyAssistantTask(target, 'other-turn', 'success')
    expect(mocks.send).toHaveBeenCalledTimes(3)
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      meta: { assistantTarget: target },
      message: 'assistantPeripheral.notify_success'
    })
    expect(JSON.stringify(mocks.send.mock.calls)).not.toContain('PRIVATE_CONTENT')
  })
  it('does not notify the focused current conversation, but does notify another conversation', async () => {
    mocks.focused = true
    await notifyAssistantTask(target, 'viewed', 'success')
    expect(mocks.send).not.toHaveBeenCalled()
    await notifyAssistantTask({ ...target, sessionId: 'other' }, 'not-viewed', 'success')
    expect(mocks.send).toHaveBeenCalledOnce()
  })
  it('respects the assistant notification preference for every outcome', async () => {
    mocks.enabled = false
    for (const kind of ['success', 'error', 'permission', 'handoff'] as const)
      await notifyAssistantTask(target, 'muted', kind)
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('serializes targets without functions and dispatches the same target for native and in-app clicks', () => {
    const listener = vi.fn()
    window.addEventListener(ASSISTANT_NOTIFICATION_OPEN, listener)
    try {
      expect(openAssistantNotification(JSON.parse(JSON.stringify({ assistantTarget: target })))).toBe(true)
      expect(listener.mock.calls[0][0].detail).toEqual(target)
      expect(openAssistantNotification({ assistantTarget: { ...target, agentId: 'legacy' } })).toBe(false)
    } finally {
      window.removeEventListener(ASSISTANT_NOTIFICATION_OPEN, listener)
    }
  })
  it('rejects arbitrary routes and resolves permission targets only from matching new-assistant messages', () => {
    expect(readAssistantNotificationTarget({ ...target, sessionId: '../../settings' })).toBeUndefined()
    expect(permissionNotificationTarget('current:tool-1')).toEqual(target)
    expect(permissionNotificationTarget('unknown:tool-1')).toBeUndefined()
  })
})
