import { LEGACY_AUTOMATION_DISABLED_CODE } from '@shared/agents/legacyAutomation'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}))
vi.mock('@main/services/WindowService', () => ({ windowService: { getMainWindow: () => null } }))
vi.mock('../AgentService', () => ({ agentService: { getAgent: vi.fn() } }))
vi.mock('../SessionService', () => ({ sessionService: { createSession: vi.fn() } }))
vi.mock('../SessionMessageService', () => ({ sessionMessageService: { createSessionMessage: vi.fn() } }))
vi.mock('../TaskService', () => ({
  taskService: {
    pauseAllActiveTasks: vi.fn().mockResolvedValue(undefined),
    recoverInterruptedTaskRuns: vi.fn().mockResolvedValue(0),
    getDueTasks: vi.fn(),
    hasActiveTasks: vi.fn(),
    createTask: vi.fn(),
    getTask: vi.fn()
  }
}))
vi.mock('../ChannelService', () => ({
  channelService: {
    deactivateAllChannels: vi.fn().mockResolvedValue(undefined),
    updateChannel: vi.fn().mockResolvedValue(null),
    listChannels: vi.fn(),
    getChannel: vi.fn(),
    deleteChannel: vi.fn()
  }
}))
vi.mock('../cherryclaw/heartbeat', () => ({ readHeartbeat: vi.fn() }))
vi.mock('../channels/sessionStreamIpc', () => ({ broadcastSessionChanged: vi.fn() }))

import { channelManager } from '../channels/ChannelManager'
import { channelMessageHandler } from '../channels/ChannelMessageHandler'
import { channelService } from '../ChannelService'
import { schedulerService } from '../SchedulerService'
import { sessionMessageService } from '../SessionMessageService'
import { sessionService } from '../SessionService'
import { taskService } from '../TaskService'

describe('legacy automation shutdown with real product policy', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pauses on startup and never restores polling or creates heartbeats', async () => {
    await schedulerService.restoreSchedulers()
    schedulerService.startLoop()
    await schedulerService.syncScheduler()
    await schedulerService.ensureHeartbeatTask('legacy')
    await (schedulerService as any).tick()
    expect(taskService.pauseAllActiveTasks).toHaveBeenCalledOnce()
    expect(taskService.recoverInterruptedTaskRuns).toHaveBeenCalledWith(expect.objectContaining({ status: 'paused' }))
    expect(taskService.getDueTasks).not.toHaveBeenCalled()
    expect(taskService.hasActiveTasks).not.toHaveBeenCalled()
    expect(taskService.createTask).not.toHaveBeenCalled()
  })

  it('rejects manual runs, resume and private execution before touching sessions/models', async () => {
    await expect(schedulerService.runTaskNow('legacy', 'task')).rejects.toMatchObject({
      code: LEGACY_AUTOMATION_DISABLED_CODE
    })
    await expect(schedulerService.updateTaskStatus('legacy', 'task', 'active')).rejects.toMatchObject({
      code: LEGACY_AUTOMATION_DISABLED_CODE
    })
    await expect((schedulerService as any).runTask({ id: 'task' })).rejects.toMatchObject({
      code: LEGACY_AUTOMATION_DISABLED_CODE
    })
    expect(taskService.getTask).not.toHaveBeenCalled()
    expect(sessionService.createSession).not.toHaveBeenCalled()
    expect(sessionMessageService.createSessionMessage).not.toHaveBeenCalled()
  })

  it('aborts active scheduled runs and persists paused state after finalization', async () => {
    const controller = new AbortController()
    const finished = vi.fn()
    const completion = new Promise<void>((resolve) =>
      controller.signal.addEventListener('abort', () => {
        finished()
        resolve()
      })
    )
    ;(schedulerService as any).activeTasks.set('task', { abortController: controller, completion })
    await schedulerService.shutdownLegacyAutomation()
    expect(controller.signal.aborted).toBe(true)
    expect(finished.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(taskService.pauseAllActiveTasks).mock.invocationCallOrder[0]
    )
    expect(sessionMessageService.createSessionMessage).not.toHaveBeenCalled()
  })

  it('disconnects existing adapters, clears QR waiters and disables persisted connections without deleting', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined)
    const remoteAbort = new AbortController()
    const reject = vi.fn()
    const timer = setTimeout(() => {}, 60_000)
    ;(channelMessageHandler as any).activeAbortControllers.set('remote', remoteAbort)
    ;(channelManager as any).adapters.set('legacy:wechat', { disconnect, channelId: 'wechat', agentId: 'legacy' })
    ;(channelManager as any).qrWaiters.set('legacy:wechat', { timer, reject })
    await channelManager.start()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(remoteAbort.signal.aborted).toBe(true)
    expect(reject).toHaveBeenCalledOnce()
    expect(channelManager.getAllStatuses()).toEqual([])
    expect(channelService.deactivateAllChannels).toHaveBeenCalledOnce()
    expect(channelService.deleteChannel).not.toHaveBeenCalled()
    expect(channelService.listChannels).not.toHaveBeenCalled()
  })

  it('blocks reconnect, QR and stale incoming events/commands', async () => {
    await channelManager.syncChannel('wechat')
    expect(channelService.updateChannel).toHaveBeenCalledWith('wechat', { isActive: false })
    expect(() => channelManager.waitForQrUrl('legacy', 'wechat')).toThrow()
    await channelMessageHandler.handleIncoming({} as any, {} as any)
    await channelMessageHandler.handleCommand({} as any, {} as any)
    expect(channelService.getChannel).toHaveBeenCalledWith('wechat')
    expect(sessionService.createSession).not.toHaveBeenCalled()
    expect(sessionMessageService.createSessionMessage).not.toHaveBeenCalled()
  })

  it('does not turn off a new-assistant connection through the closed legacy sync endpoint', async () => {
    vi.mocked(channelService.getChannel).mockResolvedValueOnce({ agentId: DEFAULT_OPENCODE_AGENT_ID } as any)
    await channelManager.syncChannel('new-wechat')
    expect(channelService.updateChannel).not.toHaveBeenCalled()
    expect(sessionMessageService.createSessionMessage).not.toHaveBeenCalled()
  })

  it('settles buffered incoming messages and discards their timers without running them', async () => {
    const resolve = vi.fn()
    const reject = vi.fn()
    const timer = setTimeout(() => reject(new Error('Buffered task escaped shutdown')), 60_000)
    ;(channelMessageHandler as any).pendingBatches.set('legacy:wechat:chat', {
      timer,
      resolvers: [{ resolve, reject }]
    })
    await channelMessageHandler.stopAll()
    expect(resolve).toHaveBeenCalledOnce()
    expect(reject).not.toHaveBeenCalled()
    expect((channelMessageHandler as any).pendingBatches.size).toBe(0)
    expect(sessionMessageService.createSessionMessage).not.toHaveBeenCalled()
  })
})
