import path from 'node:path'

import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { app } from 'electron'

import { backupAssistantFile } from './assistantFileSafety'
import { searchAssistantWeb } from './assistantWebSearch'

export type AssistantProductOptions = {
  workspace: string
  signal?: AbortSignal
  readOnly?: boolean
  onTool?: (name: string, durationMs: number, failed: boolean) => void
  readNativeSkills: (signal?: AbortSignal) => Promise<Array<{ name: string; description?: string; location?: string }>>
  approveOverwrite: (file: string) => Promise<boolean>
}

export const ASSISTANT_PRODUCT_TOOLS: Tool[] = [
  {
    name: 'web_search',
    description:
      'Search public webpages when the user requests research or current facts. Sends only the query to Exa public MCP (subject to its limits); never include private attachments, secrets or full conversation. Returns source extracts, not verified full pages. Use browser to verify sources and publication dates. Do not search for greetings or tasks answerable locally.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 1500 }, count: { type: 'integer', minimum: 1, maximum: 8 } },
      required: ['query']
    }
  },
  {
    name: 'environment',
    description:
      'Read actual local date/time, timezone, platform, workspace, authorized folders and known system paths on demand. No network probes or commands. Returned system paths are NOT new access authorization. Do not call for greetings or every turn.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'skill_status',
    description:
      'Read the current OpenCode native skill inventory on demand: actual discovered skill name, description and winning definition path. Discovery does NOT prove script/dependency compatibility or that a skill was used. Do not inspect before every task.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'backup_file',
    description:
      'Back up one existing authorized regular file before native edit/shell/Python modification. Returns original and backup paths. Does not change/delete the original or restore automatically. Backups are retained in .zen-backups beside the original. Max 128 MiB. Do not back up every file for ordinary read-only questions.',
    inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
  }
]

export async function callAssistantProductTool(
  name: string,
  args: Record<string, unknown>,
  roots: string[],
  options: AssistantProductOptions,
  requestSignal?: AbortSignal
) {
  const signal =
    options.signal && requestSignal
      ? AbortSignal.any([options.signal, requestSignal])
      : (options.signal ?? requestSignal)
  signal?.throwIfAborted()
  if (name === 'web_search') return searchAssistantWeb(args.query, args.count, signal)
  if (name === 'environment')
    return {
      now: new Date().toISOString(),
      local_time: new Date().toLocaleString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: process.platform,
      arch: process.arch,
      workspace: options.workspace,
      authorized_folders: roots,
      system_paths: Object.fromEntries(
        (['desktop', 'documents', 'downloads', 'temp'] as const).map((key) => [key, app.getPath(key)])
      ),
      authorization: 'System paths are informational only. Only authorized_folders permit tool access.'
    }
  if (name === 'skill_status') {
    const inventory = await options.readNativeSkills(signal)
    return {
      state: 'native-discovered',
      skills: inventory.map(({ name, description, location }) => ({ name, description, location })),
      limitations:
        'This is the current native inventory, not a claim that all skills were applied. Same-name definitions are represented by the winning location. Declared dependencies and external services still need compatibility review.'
    }
  }
  if (name === 'backup_file') {
    if (typeof args.file_path !== 'string' || !args.file_path.trim()) throw new Error('A file_path is required')
    const file = path.resolve(options.workspace, args.file_path)
    return { status: 'backup-created', ...(await backupAssistantFile(file, roots, signal)) }
  }
  throw new Error(`Unknown product tool: ${name}`)
}
