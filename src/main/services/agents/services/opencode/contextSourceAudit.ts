type Category = 'instructions' | 'toolSchemas' | 'user' | 'assistant' | 'toolResults' | 'other'
type ToolSource = 'web_search' | 'literature_search' | 'read_webpage' | 'read_paper' | 'other'
type Size = { items: number; jsonCharacters: number; jsonBytes: number }
const size = (): Size => ({ items: 0, jsonCharacters: 0, jsonBytes: 0 })
const object = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : undefined
const source = (name: unknown): ToolSource => {
  if (typeof name === 'string')
    for (const known of ['web_search', 'literature_search', 'read_webpage', 'read_paper'] as const)
      if (name === known || name.endsWith(`__${known}`)) return known
  return 'other'
}

/** Bounded observation of the existing request, never a context rewriter.
 * Character/byte sizes are not model tokens. No prompt, URL, tool ID or source
 * text leaves this observer; fingerprints use the private per-turn audit key.
 */
export class ContextSourceAudit {
  private previousTools = new Set<string>()
  constructor(private fingerprint: (text: string) => string) {}

  inspect(body: Record<string, any>) {
    const categories: Record<Category, Size> = {
      instructions: size(),
      toolSchemas: size(),
      user: size(),
      assistant: size(),
      toolResults: size(),
      other: size()
    }
    const tools: Record<ToolSource, Size> = {
      web_search: size(),
      literature_search: size(),
      read_webpage: size(),
      read_paper: size(),
      other: size()
    }
    const calls = new Map<string, ToolSource>()
    const currentTools = new Set<string>()
    const excerpts = new Set<string>()
    const largest: Array<{ category: Category; source?: ToolSource; jsonCharacters: number; fingerprint: string }> = []
    let repeatedToolJsonCharacters = 0
    let carriedToolJsonCharacters = 0
    let repeatedExcerptCharacters = 0
    let visited = 0
    let limited = false
    const add = (category: Category, value: unknown, tool?: ToolSource) => {
      const encoded = JSON.stringify(value)
      if (encoded === undefined) return
      const chars = encoded.length
      const bytes = Buffer.byteLength(encoded)
      for (const counter of [categories[category], ...(tool ? [tools[tool]] : [])]) {
        counter.items++
        counter.jsonCharacters += chars
        counter.jsonBytes += bytes
      }
      const fingerprint = this.fingerprint(encoded)
      largest.push({ category, ...(tool ? { source: tool } : {}), jsonCharacters: chars, fingerprint })
      largest.sort((a, b) => b.jsonCharacters - a.jsonCharacters)
      largest.length = Math.min(largest.length, 8)
      if (category !== 'toolResults') return
      if (currentTools.has(fingerprint)) repeatedToolJsonCharacters += chars
      if (this.previousTools.has(fingerprint)) carriedToolJsonCharacters += chars
      currentTools.add(fingerprint)
      // Managed readers may return identical text with different cache metadata.
      // Count exact excerpts separately, without calling different PDF pages or
      // overlapping-but-not-identical sections duplicates.
      if (tool !== 'read_webpage' && tool !== 'read_paper') return
      try {
        let payload = value
        for (let depth = 0; depth < 4; depth++) {
          if (typeof payload === 'string') payload = JSON.parse(payload)
          else if (Array.isArray(payload) && payload.length === 1) payload = payload[0]
          else if (object(payload)?.type === 'text') payload = object(payload)!.text
          else break
        }
        const result = object(payload)
        const chunks = Array.isArray(result?.chunks) ? result.chunks.slice(0, 256) : []
        const excerptsAtLocation = chunks
          .filter((chunk) => typeof chunk?.text === 'string')
          .map((chunk) => ({
            section: chunk.section,
            start: chunk.char_start,
            end: chunk.char_end,
            text: chunk.text
          }))
        const text =
          typeof result?.text === 'string' ? result.text : excerptsAtLocation.map((chunk) => chunk.text).join('')
        if (text.length) {
          const hash = this.fingerprint(
            JSON.stringify([result?.source_url, result?.selector, result?.offset, excerptsAtLocation, text])
          )
          if (excerpts.has(hash)) repeatedExcerptCharacters += text.length
          excerpts.add(hash)
        }
      } catch {
        /* A plain or truncated tool result is still counted by its JSON size. */
      }
    }
    const rows = [body.messages, body.input].flatMap((value) => (Array.isArray(value) ? value : []))
    if (rows.length > 4096) limited = true
    const bounded = rows.slice(0, 4096)
    for (const value of bounded) {
      const row = object(value)
      if (!row) continue
      if (row.type === 'function_call' && typeof row.call_id === 'string') calls.set(row.call_id, source(row.name))
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls.slice(0, 256) : [])
        if (typeof call?.id === 'string') calls.set(call.id, source(call.function?.name))
      for (const part of Array.isArray(row.content) ? row.content.slice(0, 256) : [])
        if (part?.type === 'tool_use' && typeof part.id === 'string') calls.set(part.id, source(part.name))
    }
    const content = (value: unknown, category: Category, tool?: ToolSource) => {
      if (++visited > 8192) {
        limited = true
        return
      }
      if (Array.isArray(value)) {
        if (value.length > 256) limited = true
        for (const part of value.slice(0, 256)) {
          if (++visited > 8192) {
            limited = true
            break
          }
          const item = object(part)
          if (item?.type === 'tool_result') add('toolResults', item.content, calls.get(item.tool_use_id) ?? 'other')
          else add(category, part, tool)
        }
      } else if (value !== undefined) add(category, value, tool)
    }
    if (body.system !== undefined) content(body.system, 'instructions')
    if (body.instructions !== undefined) content(body.instructions, 'instructions')
    if (body.tools !== undefined) add('toolSchemas', body.tools)
    if (typeof body.input === 'string') content(body.input, 'user')
    for (const value of bounded) {
      const row = object(value)
      if (!row) {
        content(value, 'other')
        continue
      }
      if (row.type === 'function_call_output') {
        content(row.output, 'toolResults', calls.get(row.call_id) ?? 'other')
        continue
      }
      const category: Category = ['system', 'developer'].includes(row.role)
        ? 'instructions'
        : row.role === 'user'
          ? 'user'
          : row.role === 'assistant' || row.type === 'function_call'
            ? 'assistant'
            : row.role === 'tool'
              ? 'toolResults'
              : 'other'
      content(
        row.content !== undefined ? row.content : row.role !== undefined ? undefined : row,
        category,
        category === 'toolResults' ? (calls.get(row.tool_call_id) ?? source(row.name)) : undefined
      )
      if (row.tool_calls) add('assistant', row.tool_calls)
    }
    this.previousTools = currentTools
    return {
      contextAuditVersion: 1,
      coverage: limited ? 'limited' : 'complete',
      categories,
      tools,
      largest,
      repeatedToolJsonCharacters,
      carriedToolJsonCharacters,
      repeatedExcerptCharacters,
      measurement:
        'JSON value characters/UTF-8 bytes, not tokens; excludes JSON framing and unclassified protocol fields. Repeated=exact tool values within this request; carried=also present in the previous observed request (normal history, not waste). Repeated excerpts can overlap repeated JSON counts. Fingerprints are private to this turn. No content removed; native compaction is unchanged.'
    }
  }
}
