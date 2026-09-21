import * as z from 'zod'

import type { CdpBrowserController } from '../controller'
import { logger } from '../types'
import { errorResponse, successResponse } from './utils'

const DownloadFilterSchema = z.object({
  privateMode: z.boolean().optional().describe('Target private session (default: false)'),
  tabId: z.string().optional().describe('Only include downloads from a specific tab')
})

export const listDownloadsToolDefinition = {
  name: 'list_downloads',
  description:
    'List recent browser downloads with their status, filename, path, progress, and error information. Use this when a download may already have finished or when you need to identify a download before presenting it to the user.',
  inputSchema: {
    type: 'object',
    properties: {
      privateMode: { type: 'boolean', description: 'Target private session (default: false)' },
      tabId: { type: 'string', description: 'Only include downloads from a specific tab' }
    }
  }
}

export const WaitForDownloadSchema = DownloadFilterSchema.extend({
  downloadId: z.string().optional().describe('Wait for one specific download returned by list_downloads'),
  timeoutMs: z.number().optional().describe('Maximum wait time in milliseconds (default: 120000, maximum: 900000)')
})

export const waitForDownloadToolDefinition = {
  name: 'wait_for_download',
  description:
    'Wait for a browser download to finish after clicking a download link or button. The browser automatically saves downloads into Zen AI Browser Downloads. Use this after the click, then call mcp__assistant__present_files with the completed path when the file is a final user-facing deliverable. This tool does not bypass login, CAPTCHA, payment, authorization, or anti-abuse checks.',
  inputSchema: {
    type: 'object',
    properties: {
      downloadId: { type: 'string', description: 'Specific download ID from list_downloads' },
      privateMode: { type: 'boolean', description: 'Target private session (default: false)' },
      tabId: { type: 'string', description: 'Only wait for downloads from a specific tab' },
      timeoutMs: { type: 'number', description: 'Maximum wait time in milliseconds (default: 120000, maximum: 900000)' }
    }
  }
}

export async function handleListDownloads(controller: CdpBrowserController, args: unknown) {
  try {
    const { privateMode, tabId } = DownloadFilterSchema.parse(args)
    return successResponse(JSON.stringify(controller.listDownloads({ privateMode, tabId })))
  } catch (error) {
    logger.error('List browser downloads failed', { error })
    return errorResponse(error instanceof Error ? error : String(error))
  }
}

export async function handleWaitForDownload(controller: CdpBrowserController, args: unknown) {
  try {
    const { downloadId, privateMode, tabId, timeoutMs } = WaitForDownloadSchema.parse(args)
    const download = await controller.waitForDownload({ downloadId, privateMode, tabId, timeoutMs })
    return successResponse(JSON.stringify(download))
  } catch (error) {
    logger.error('Wait for browser download failed', { error })
    return errorResponse(error instanceof Error ? error : String(error))
  }
}
