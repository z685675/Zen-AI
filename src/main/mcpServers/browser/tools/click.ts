import * as z from 'zod'

import type { CdpBrowserController } from '../controller'
import { errorResponse, successResponse } from './utils'

const ClickSchema = z.object({
  snapshotId: z.string().uuid(),
  ref: z.number().int().positive(),
  expectedText: z.string().trim().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(0).max(10000).default(3000),
  privateMode: z.boolean().optional(),
  tabId: z.string().optional()
})

export const clickToolDefinition = {
  name: 'click',
  description:
    'Click one observed element using its snapshot ID and numbered ref. Never repeat a click on the same observed ref; inspect a fresh snapshot before a new action. Uses native mouse input and optionally waits for expectedText on that same element, combining click and state verification. An already satisfied state does not click again. Stale, covered or disabled targets fail before clicking. verified:false is not business success; inspect the current page, never blindly repeat a click. Login/CAPTCHA and final publish/submit/delete/pay/security confirmations still require visible handoff and explicit user confirmation.',
  inputSchema: {
    type: 'object',
    properties: {
      snapshotId: { type: 'string', description: 'Snapshot ID from the latest snapshot of this tab.' },
      ref: { type: 'integer', minimum: 1, description: 'Numbered ref of the observed target.' },
      expectedText: {
        type: 'string',
        description:
          'Optional expected text on the same target after clicking, e.g. 已关注. If already present, no click is sent.'
      },
      timeoutMs: {
        type: 'integer',
        minimum: 0,
        maximum: 10000,
        description: 'Bounded state observation, default 3000 ms.'
      },
      privateMode: { type: 'boolean' },
      tabId: { type: 'string' }
    },
    required: ['snapshotId', 'ref']
  }
}

export async function handleClick(controller: CdpBrowserController, args: unknown) {
  try {
    const a = ClickSchema.parse(args)
    const result = await controller.click(
      a.snapshotId,
      a.ref,
      a.expectedText,
      a.timeoutMs,
      a.privateMode ?? false,
      a.tabId
    )
    // Detection is observation after a side effect; its failure must not invite
    // a second click by disguising a completed action as a tool failure.
    const userAction = await controller
      .waitForUserActionDetection(a.privateMode ?? false, a.tabId)
      .catch(() => undefined)
    return successResponse(JSON.stringify({ ...result, ...(userAction ? { userAction } : {}) }))
  } catch (error) {
    return errorResponse(error instanceof Error ? error : String(error))
  }
}
