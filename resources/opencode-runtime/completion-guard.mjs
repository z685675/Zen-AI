import path from 'node:path'

const fileTools = new Set(['write', 'edit', 'multiedit', 'apply_patch'])

function editedFiles(tool, args, directory) {
  if (['write', 'edit', 'multiedit'].includes(tool) && typeof args?.filePath === 'string')
    return [path.resolve(directory, args.filePath)]
  if (tool !== 'apply_patch' || typeof args?.patchText !== 'string') return []
  const headers = /^\*\*\* (?:Add File:|Update File:|Delete File:|Move to:) (.+)$/gm
  return Array.from(args.patchText.matchAll(headers), (match) => path.resolve(directory, match[1].trim())).slice(0, 32)
}

// Product-owned native plugin. Keep compaction/replay in OpenCode's own loop.
export default async function completionGuard({ client, directory }) {
  const url = process.env.ZEN_FILE_CHANGES_URL
  const auth = process.env.ZEN_FILE_CHANGES_AUTH
  const token = process.env.ZEN_FILE_CHANGES_TOKEN
  const turnSystems = new Map()
  const notifyChange = async (action, callId, files) => {
    if (!url || !token || !auth) return false
    try {
      const result = await fetch(url, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json', 'X-Zen-File-Change-Token': token },
        body: JSON.stringify({ action, callId, files }),
        signal: AbortSignal.timeout(5000)
      })
      return result.ok
    } catch {
      return false
    }
  }
  return {
    'chat.message': async ({ sessionID }, { message, parts }) => {
      if (message.system && turnSystems.size < 32) turnSystems.set(sessionID, message.system)
      if (
        !message.system &&
        parts.some((part) => part.type === 'text' && part.synthetic && /^<task id="ses_[\w-]+" state="(?:completed|error)">\s*<summary>Background task (?:completed|failed):/.test(part.text))
      ) {
        message.system = turnSystems.get(sessionID)
      }
    },
    'tool.execute.before': async (input, output) => {
      if (url && directory && typeof input.callID === 'string') {
        const files = editedFiles(input.tool, output.args, directory)
        const call = `${input.sessionID}:${input.callID}`
        if (files.length) await notifyChange('begin', call, files)
      }
      if (input.tool !== 'task' || typeof output.args?.task_id !== 'string') return
      const response = await client.session.get({ path: { id: output.args.task_id }, signal: AbortSignal.timeout(3000) })
      if (response.data?.parentID !== input.sessionID) {
        throw new Error('This child task belongs to another conversation. Start a new child with a complete description instead of resuming that task_id.')
      }
    },
    'tool.execute.after': async (input, output) => {
      const call = `${input.sessionID}:${input.callID}`
      if (url && fileTools.has(input.tool) && typeof input.callID === 'string') await notifyChange('finish', call)
      if (input.tool !== 'webfetch' || typeof output.output !== 'string') return
      if (/^\s*%PDF-\d/.test(output.output)) {
        output.output = JSON.stringify({
          status: 'pdf_requires_parser',
          source_url: typeof input.args?.url === 'string' ? input.args.url : undefined,
          evidence_level: 'unavailable',
          guidance: 'No paper text was extracted. Use mcp__assistant__read_paper with the direct PDF URL, or read_document for an authorized downloaded PDF. Do not retry webfetch on this PDF.'
        })
        output.metadata = { ...output.metadata, zenContentStatus: 'pdf_requires_parser' }
      } else if (output.output.length > 16000) {
        const length = output.output.length
        output.output = `${output.output.slice(0, 12000)}\n[Partial webpage: ${length} characters, middle omitted. Read only the relevant section with a browser selector; do not repeat the full-page dump.]\n${output.output.slice(-4000)}`
        output.metadata = { ...output.metadata, zenContentStatus: 'partial', originalCharacters: length }
      }
    },
    'experimental.compaction.autocontinue': async (input, output) => {
      if (input.overflow) return
      try {
        const response = await client.session.messages({
          path: { id: input.sessionID },
          query: { limit: 20 },
          signal: AbortSignal.timeout(3000)
        })
        const messages = response.data
        if (!Array.isArray(messages)) return
        const boundary = messages.findIndex(({ info }) => info.id === input.message.id)
        if (boundary < 1) return
        const before = messages.slice(0, boundary)
        const answer = before.findLast(({ info }) => info.role === 'assistant' && !info.summary)
        const user = before.findLast(
          ({ info, parts }) => info.role === 'user' && parts.some((part) => part.type === 'text' && !part.synthetic)
        )
        // Some providers report stop even with tool calls. Those results still
        // need to be consumed; ambiguous or unavailable evidence stays native.
        if (
          !answer || !user || answer.info.parentID !== user.info.id ||
          answer.info.finish !== 'stop' || !answer.info.time?.completed || answer.info.error ||
          answer.parts.some((part) => part.type === 'tool') ||
          !answer.parts.some((part) => part.type === 'text' && part.text?.trim())
        ) return
        output.enabled = false
      } catch {
        // Diagnostics/plugins must never prevent mid-task context recovery.
      }
    }
  }
}
