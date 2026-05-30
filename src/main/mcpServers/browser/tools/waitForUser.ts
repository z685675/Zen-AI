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
  timeout: z.number().optional().describe('How long to wait in milliseconds. Default: 15 minutes.'),
  privateMode: z.boolean().optional().describe('Target private session (default: false). Avoid private mode for login reuse.')
})

export const waitForUserToolDefinition = {
  name: 'wait_for_user',
  description:
    'Show the Zen AI internal browser window with a handoff bar and wait until the user clicks Continue. Use after opening a page visibly when login, CAPTCHA, authorization, confirmation, upload/download choice, or other manual browser interaction is required. Do not use this for ordinary background search or public page extraction.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Message shown to the user in the browser handoff bar.'
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
      }
    }
  }
}

export async function handleWaitForUser(controller: CdpBrowserController, args: unknown) {
  try {
    const { message, reason, timeout, privateMode } = WaitForUserSchema.parse(args)
    const result = await controller.waitForUser(message, reason, timeout, privateMode ?? false)
    return successResponse(JSON.stringify(result))
  } catch (error) {
    logger.error('Wait for user failed', { error })
    const message = error instanceof Error ? error.message : String(error)
    if (message.toLowerCase().includes('timed out waiting for user')) {
      return errorResponse('等待网页接管超时。请重新发起任务，或再次打开网页完成登录、验证或确认后继续。')
    }
    return errorResponse(message)
  }
}
