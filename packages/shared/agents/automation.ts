import * as z from 'zod'

const id = z.string().trim().min(1).max(512)
export const automationTaskInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(24_000),
    model: id.optional(),
    scheduleType: z.enum(['once', 'interval', 'cron']),
    scheduleValue: z.string().trim().min(1).max(128),
    notify: z.boolean().default(false),
    authorized: z.literal(true)
  })
  .strict()
export const automationRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('login') }),
  z.object({ action: z.literal('confirm'), authorized: z.literal(true) }),
  z.object({ action: z.literal('disconnect') }),
  z.object({ action: z.literal('newChat') }),
  z.object({ action: z.literal('sync'), sessionId: id, enabled: z.boolean() }),
  z.object({
    action: z.literal('delivery'),
    id: z.number().int().positive(),
    decision: z.enum(['retry', 'cancel']),
    confirmed: z.literal(true)
  }),
  z.object({ action: z.literal('createTask'), task: automationTaskInput }),
  z.object({ action: z.literal('updateTask'), id, task: automationTaskInput }),
  z.object({ action: z.literal('task'), id, operation: z.enum(['pause', 'resume', 'run', 'stop', 'delete']) }),
  z.object({ action: z.literal('stopSession'), sessionId: id })
])
export type AutomationRequest = z.infer<typeof automationRequestSchema>
export type AutomationTaskInput = z.infer<typeof automationTaskInput>
export type AutomationOverview = {
  connection: { status: string; qr?: string; owner?: string; sessionId?: string; enabled?: boolean; reason?: string }
  deliveries: Array<{ id: number; state: string; role: string; reason: string | null; createdAt: number }>
  tasks: Array<{
    id: string
    name: string
    prompt: string
    model: string | null
    scheduleType: string
    scheduleValue: string
    status: string
    nextRun: string | null
    lastResult: string | null
    notify: boolean
    notificationNeedsConfirmation: boolean
  }>
  runs: Array<{
    id: number
    taskId: string
    sessionId: string | null
    status: string
    result: string | null
    error: string | null
    runAt: string
  }>
  legacyTasks: Array<{
    id: string
    name: string
    prompt: string
    model: string | null
    scheduleType: string
    scheduleValue: string
  }>
  sessions: Array<{ id: string; name: string | null; current: boolean }>
}
export type AutomationResponse = { ok: true; data: AutomationOverview } | { ok: false; code: string }
