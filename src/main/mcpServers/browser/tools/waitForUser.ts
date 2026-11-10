import * as z from 'zod'

import type { CdpBrowserController } from '../controller'
import { logger } from '../types'
import { errorResponse, successResponse } from './utils'

export const WaitForUserSchema = z.object({
  message: z
    .string()
    .optional()
    .describe('Message shown in the visible browser handoff bar. Tell the user what to complete.'),
  reason: z
    .string()
    .optional()
    .describe('Short reason for the handoff, e.g. login_required, captcha, authorization, confirmation.'),
  timeout: z
    .number()
    .finite()
    .positive()
    .max(30 * 60_000)
    .optional()
    .describe('How long to wait in milliseconds. Default: 15 minutes. Verification handoffs allow at least 5 minutes.'),
  privateMode: z
    .boolean()
    .optional()
    .describe('Target private session (default: false). Avoid private mode for login reuse.'),
  tabId: z.string().optional().describe('Target specific tab when multiple tabs are open')
})

export const waitForUserToolDefinition = {
  name: 'wait_for_user',
  description:
    'Show the Zen AI internal browser window with a handoff bar and wait until the user clicks Continue. Use after opening a page visibly when login, CAPTCHA, 2FA, authorization, account access, final publish/submit/delete confirmation, upload/download choice, file picker, site check-in, dashboard/admin workflow, or other manual browser interaction is required. Browser automation is paused during handoff. After Continue, inspect the page and continue the original task. If externalBrowserOpened is returned, system-browser cookies and verification are not shared: follow the returned guidance instead of repeating a blocked challenge. Do not use this for ordinary background search or public page extraction.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description:
          'Message shown to the user in the browser handoff bar. Be concrete: tell them what to finish, such as login, verification, file selection, or final confirmation review.'
      },
      reason: {
        type: 'string',
        description: 'Short reason for the handoff.'
      },
      timeout: {
        type: 'number',
        description: 'How long to wait in milliseconds. Default: 15 minutes.'
      },
      privateMode: {
        type: 'boolean',
        description: 'Target private session (default: false). Avoid private mode for login reuse.'
      },
      tabId: {
        type: 'string',
        description: 'Target specific tab when multiple tabs are open'
      }
    }
  }
}

export async function handleWaitForUser(controller: CdpBrowserController, args: unknown) {
  try {
    const { message, reason, timeout, privateMode, tabId } = WaitForUserSchema.parse(args)
    const handoff = controller.getAutomationHandoff(privateMode ?? false)
    const waitMs = reason || handoff ? Math.max(timeout ?? 15 * 60_000, 5 * 60_000) : timeout
    const result = await controller.waitForUser(
      message,
      handoff?.userAction.reason ?? reason,
      waitMs,
      privateMode ?? false,
      handoff?.tabId ?? tabId
    )
    return successResponse(JSON.stringify(result))
  } catch (error) {
    logger.error('Wait for user failed', { error })
    const message = error instanceof Error ? error.message : String(error)
    if (message.toLowerCase().includes('timed out waiting for user')) {
      return successResponse(
        JSON.stringify({
          status: 'timed_out',
          service: 'Zen browser handoff',
          executed: false,
          guidance:
            'The user has not completed browser verification. This page was not retrieved. Continue independent work using accessible sources, or ask the user to finish verification and continue later. Do not restart the whole task or repeat the challenge automatically.'
        })
      )
    }
    return errorResponse(message)
  }
}
