import * as z from 'zod'

import type { CdpBrowserController } from '../controller'
import { logger } from '../types'
import { errorResponse, successResponse } from './utils'

export const ExecuteSchema = z.object({
  code: z.string().describe('JavaScript code to run in page context'),
  timeout: z.number().default(5000).describe('Execution timeout in ms (default: 5000)'),
  maxChars: z.number().int().min(256).max(24000).default(12000),
  privateMode: z.boolean().optional().describe('Target private session (default: false)'),
  tabId: z.string().optional().describe('Target specific tab by ID')
})

export const executeToolDefinition = {
  name: 'execute',
  description:
    'Run JavaScript in the currently open page. Use after open to: click elements, fill forms, extract content (document.body.innerText), or interact with the page. The page must be opened first with open or fetch. Do not use this to bypass CAPTCHA, 2FA, payment/security prompts, anti-abuse protections, or final high-impact confirmations. For publish/submit/delete/pay/overwrite or account-security confirmations, prepare drafts/previews where safe, then use visible browser handoff and wait for explicit user confirmation.',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          'JavaScript to evaluate. Examples: document.body.innerText (get text), document.querySelector("button").click() (click), document.title (get title)'
      },
      timeout: {
        type: 'number',
        description: 'Execution timeout in ms (default: 5000)'
      },
      maxChars: {
        type: 'integer',
        minimum: 256,
        maximum: 24000,
        default: 12000,
        description:
          'Bound returned content; use targeted selectors for missing sections instead of dumping the whole page.'
      },
      privateMode: {
        type: 'boolean',
        description: 'Target private session (default: false)'
      },
      tabId: {
        type: 'string',
        description: 'Target specific tab by ID (from open response)'
      }
    },
    required: ['code']
  }
}

export async function handleExecute(controller: CdpBrowserController, args: unknown) {
  const { code, timeout, maxChars, privateMode, tabId } = ExecuteSchema.parse(args)
  try {
    const value = await controller.execute(code, timeout, privateMode ?? false, tabId)
    const serialized = (typeof value === 'string' ? value : JSON.stringify(value)) ?? 'null'
    const result =
      serialized.length > maxChars
        ? {
            truncated: true,
            totalChars: serialized.length,
            preview: serialized.slice(0, maxChars),
            guidance: 'Extract only the relevant section with a selector. This is a partial page read.'
          }
        : value
    const userAction = await controller.waitForUserActionDetection(privateMode ?? false, tabId)
    if (userAction) {
      return successResponse(JSON.stringify({ result, userAction }))
    }
    return successResponse(typeof result === 'string' ? result : JSON.stringify(result))
  } catch (error) {
    logger.error('Execute failed', { error, code: code.slice(0, 100), privateMode, tabId })
    return errorResponse(error as Error)
  }
}
