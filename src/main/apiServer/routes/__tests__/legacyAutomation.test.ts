import type { Server } from 'node:http'

import { LEGACY_AUTOMATION_DISABLED_CODE } from '@shared/agents/legacyAutomation'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@main/services/agents/services/TaskService', () => ({
  taskService: { listAllTasks: vi.fn().mockResolvedValue({ tasks: [], total: 0 }), createTask: vi.fn() }
}))
vi.mock('@main/services/agents/services/SchedulerService', () => ({
  schedulerService: { runTaskNow: vi.fn(), startLoop: vi.fn() }
}))
vi.mock('@main/services/agents/services/ChannelService', () => ({
  channelService: { listChannels: vi.fn().mockResolvedValue([]), createChannel: vi.fn() }
}))
vi.mock('@main/services/agents/services/channels/ChannelManager', () => ({
  channelManager: { syncChannel: vi.fn() }
}))

import { channelService } from '@main/services/agents/services/ChannelService'
import { taskService } from '@main/services/agents/services/TaskService'

import { channelsRouter } from '../channels'
import { tasksRouter } from '../tasks'

describe('legacy automation REST boundary', () => {
  let server: Server
  let baseUrl: string
  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use('/tasks', tasksRouter)
    app.use('/channels', channelsRouter)
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))

  it.each([
    ['POST', '/tasks'],
    ['POST', '/tasks/task/run'],
    ['PATCH', '/tasks/task'],
    ['POST', '/channels'],
    ['PATCH', '/channels/wechat']
  ])('rejects %s %s even with developer-mode input', async (method, route) => {
    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ developerMode: true, is_active: true, status: 'active' })
    }
    const response = await fetch(`${baseUrl}${route}`, options)
    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({
      error: { code: LEGACY_AUTOMATION_DISABLED_CODE, type: 'feature_disabled' }
    })
    expect(taskService.createTask).not.toHaveBeenCalled()
    expect(channelService.createChannel).not.toHaveBeenCalled()
  })

  it.each(['/tasks', '/channels'])('preserves reading historical configuration: %s', async (route) => {
    const response = await fetch(`${baseUrl}${route}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: [] })
  })
})
