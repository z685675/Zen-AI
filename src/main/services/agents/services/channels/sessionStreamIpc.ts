import { IpcChannel } from '@shared/IpcChannel'
import { ipcMain } from 'electron'
import * as z from 'zod'

import { windowService } from '../../../WindowService'
import { checkAgentRunInput, getAgentRunInputStatus, submitAgentRunInput } from '../opencode/turnInput'
import { hasSessionActivity } from '../sessionActivity'
import { channelMessageHandler } from './ChannelMessageHandler'
import { sessionStreamBus, type SessionStreamChunk } from './SessionStreamBus'

const inputId = z.string().regex(/^[\w-]{1,160}$/)
const inputSchema = z.object({
  sessionId: inputId,
  turnId: inputId,
  id: inputId,
  text: z.string().trim().min(1).max(512_000),
  images: z
    .array(
      z.object({
        media_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
        data: z
          .string()
          .max(12_000_000)
          .regex(/^[A-Za-z0-9+/=\r\n]+$/)
      })
    )
    .max(4)
    .optional()
})

const activeSubscriptions = new Map<string, () => void>()

export function registerSessionStreamIpc(): void {
  ipcMain.handle(IpcChannel.AgentSessionInput_Status, (_event, sessionId: unknown) => {
    const id = inputId.parse(sessionId)
    const status = getAgentRunInputStatus(id)
    return { ...status, active: status.active || hasSessionActivity(id) }
  })
  ipcMain.handle(IpcChannel.AgentSessionInput_Submit, (_event, raw: unknown) => {
    const parsed = inputSchema.safeParse(raw)
    if (!parsed.success) return { id: '', state: 'rejected', code: 'invalid_input' }
    return submitAgentRunInput(parsed.data)
  })
  ipcMain.handle(IpcChannel.AgentSessionInput_Check, (_event, raw: unknown) => {
    const { sessionId, id } = z.object({ sessionId: inputId, id: inputId }).parse(raw)
    return checkAgentRunInput(sessionId, id)
  })
  ipcMain.handle(IpcChannel.AgentSessionStream_Subscribe, (_event, { sessionId }: { sessionId: string }) => {
    if (activeSubscriptions.has(sessionId)) return { success: true }

    const unsubscribe = sessionStreamBus.subscribe(sessionId, (chunk: SessionStreamChunk) => {
      const mainWindow = windowService.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IpcChannel.AgentSessionStream_Chunk, chunk)
      }
    })

    activeSubscriptions.set(sessionId, unsubscribe)
    return { success: true }
  })

  ipcMain.handle(IpcChannel.AgentSessionStream_Unsubscribe, (_event, { sessionId }: { sessionId: string }) => {
    const unsub = activeSubscriptions.get(sessionId)
    if (unsub) {
      unsub()
      activeSubscriptions.delete(sessionId)
    }
    return { success: true }
  })

  ipcMain.handle(IpcChannel.AgentSessionStream_Abort, (_event, { sessionId }: { sessionId: string }) => {
    const aborted = channelMessageHandler.abortSession(sessionId)
    if (aborted) return { success: true }
    return import('../automation/AutomationService').then(async ({ automationService }) => ({
      success: await automationService.abort(sessionId)
    }))
  })
}

export type AgentSessionChangeReason = 'created' | 'completed'

export function broadcastSessionChanged(
  agentId: string,
  sessionId: string,
  headless?: boolean,
  reason: AgentSessionChangeReason = 'completed'
): void {
  const mainWindow = windowService.getMainWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.AgentSession_Changed, { agentId, sessionId, headless: !!headless, reason })
  }
}
