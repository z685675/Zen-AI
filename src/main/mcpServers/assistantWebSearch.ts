import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export const SEARCH_ENDPOINT = 'https://mcp.exa.ai/mcp?tools=web_search_exa'
let active = 0
let cooldownUntil = 0

export function parseSearchSources(text: string) {
  const sources: Array<{ title: string; url: string; published: string | null; excerpt: string }> = []
  for (const block of text
    .slice(0, 80_000)
    .split(/(?=^Title:\s)/m)
    .slice(0, 12)) {
    const title = /^Title:\s*(.+)$/m.exec(block)?.[1]
    const url = /^URL:\s*(\S+)/m.exec(block)?.[1]
    if (!title || !url) continue
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue
      sources.push({
        title: title.slice(0, 300),
        url: parsed.href,
        published: /^Published(?: Date)?:\s*(.+)$/m.exec(block)?.[1]?.slice(0, 100) ?? null,
        excerpt: block.slice(0, 2000)
      })
    } catch {
      /* Never manufacture a URL for malformed/unstructured output. */
    }
  }
  return sources.slice(0, 8)
}

/** Lazy, bounded, no credential inheritance and no startup/network probe. */
export async function searchAssistantWeb(query: unknown, count: unknown, callerSignal?: AbortSignal) {
  if (typeof query !== 'string' || !query.trim() || query.length > 1500)
    throw new Error('Search query must contain 1–1500 characters')
  if (count !== undefined && (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 8))
    throw new Error('Search count must be an integer between 1 and 8')
  if (active >= 2) throw new Error('Two searches are already running; wait for one to finish')
  if (cooldownUntil > Date.now())
    throw new Error('Search service is rate limited; use browser search or try again later')
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new Error('Search timed out after 20 seconds')), 20_000)
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal
  const client = new Client({ name: 'zen-web-search', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(SEARCH_ENDPOINT), {
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 1000,
      initialReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1
    },
    fetch: async (url, init) => {
      // Only the selected public endpoint; never follow a redirect carrying query data.
      const response = await fetch(url, { ...init, signal, redirect: 'error' })
      if (response.status === 429) {
        const retry = response.headers.get('retry-after')
        const seconds =
          retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - Date.now()) / 1000 : 60
        cooldownUntil =
          Date.now() + Math.min(300_000, Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 60_000))
      }
      if (!response.body) return response
      let bytes = 0
      const bounded = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength
            if (bytes > 2 * 1024 * 1024) throw new Error('Search response exceeded 2 MiB')
            controller.enqueue(chunk)
          }
        })
      )
      return new Response(bounded, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    }
  })
  active++
  try {
    signal.throwIfAborted()
    await client.connect(transport, { signal, timeout: 20_000 })
    const result = await client.callTool(
      { name: 'web_search_exa', arguments: { query: query.trim(), numResults: count ?? 5 } },
      undefined,
      { signal, timeout: 20_000 }
    )
    if (result.isError)
      throw new Error('Search service could not complete the query; use browser search or explain the limitation')
    const texts = (result.content as Array<{ type: string; text?: string }>)
      .filter((item) => item.type === 'text')
      .map((item) => item.text ?? '')
    const text = texts.join('\n')
    if (!text.trim()) throw new Error('Search service returned no usable text')
    const sources = parseSearchSources(text)
    return {
      service: 'Exa public MCP',
      searched_at: new Date().toISOString(),
      sources,
      ...(sources.length
        ? {}
        : { result_text: text.slice(0, 24_000), parsing: 'unstructured-extract; source fields could not be verified' }),
      truncated: text.length > 24_000,
      evidence: 'Search extracts only. Open relevant original pages to verify claims/dates. Missing dates are unknown.',
      privacy:
        'The wrapper sends only the explicit query and result count; it does not attach conversation history, files or Provider keys. Do not put private information in the query. The third-party service may retain queries/use them for training.'
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    // Do not log/echo query, remote response or URL credentials in service errors.
    throw new Error(
      `Web search unavailable${typeof (error as { code?: unknown })?.code === 'number' ? ` (HTTP ${(error as { code: number }).code})` : ''}; ordinary chat is unaffected. Try the browser or retry later.`
    )
  } finally {
    clearTimeout(timer)
    timeout.abort('Search finished')
    await client.close().catch(() => undefined)
    active--
  }
}
