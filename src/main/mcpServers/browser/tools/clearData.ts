import * as z from 'zod'

import type { CdpBrowserController } from '../controller'
import { logger } from '../types'
import { errorResponse, successResponse } from './utils'

export const ClearBrowserDataSchema = z.object({
  privateMode: z
    .boolean()
    .optional()
    .describe('Clear the private session when true; clear the persistent normal session when false (default: false)')
})

export const clearBrowserDataToolDefinition = {
  name: 'clear_browser_data',
  description:
    'Clear cookies, local storage, cache, and other browser data for one Zen AI browser mode. Use only after the user explicitly asks to clear browser data or sign out everywhere; this will remove saved login sessions for that mode and cannot be undone.',
  inputSchema: {
    type: 'object',
    properties: {
      privateMode: {
        type: 'boolean',
        description: 'true=clear private session, false=clear persistent normal session (default: false)'
      }
    }
  }
}

export async function handleClearBrowserData(controller: CdpBrowserController, args: unknown) {
  try {
    const { privateMode } = ClearBrowserDataSchema.parse(args)
    await controller.clearBrowserData(privateMode ?? false)
    return successResponse(JSON.stringify({ cleared: true, privateMode: privateMode ?? false }))
  } catch (error) {
    logger.error('Clear browser data failed', { error })
    return errorResponse(error instanceof Error ? error : String(error))
  }
}
