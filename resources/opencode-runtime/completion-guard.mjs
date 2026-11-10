// Product-owned native plugin. Keep compaction/replay in OpenCode's own loop.
export default async function completionGuard({ client }) {
  return {
    'tool.execute.after': async (input, output) => {
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
