import type { MCPToolResponse, NormalToolResponse, WebSearchProviderResult } from '@renderer/types'

type ToolResponse = MCPToolResponse | NormalToolResponse

const MAX_CITATION_RESULTS = 12
const MAX_CITATION_CONTENT_LENGTH = 1200
const WEB_TOOL_NAME_PATTERN =
  /(?:builtin_web_search|web[_-]?search|web[_-]?fetch|codex\.web_search|mcp__exa__|mcp__browser__(?:open|fetch|snapshot))/i
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g

function normalizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value.replace(/[.,;:!?，。；：！？]+$/, ''))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function trimContent(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > MAX_CITATION_CONTENT_LENGTH ? `${text.slice(0, MAX_CITATION_CONTENT_LENGTH)}...` : text
}

function resultFromObject(value: Record<string, unknown>): WebSearchProviderResult | undefined {
  const rawUrl = value.url ?? value.uri ?? value.link ?? value.currentUrl ?? value.sourceUrl
  if (typeof rawUrl !== 'string') return undefined

  const url = normalizeUrl(rawUrl)
  if (!url) return undefined

  const rawTitle = value.title ?? value.name
  const rawContent = value.content ?? value.text ?? value.snippet ?? value.description
  return {
    title: typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : new URL(url).hostname,
    content: trimContent(rawContent),
    url
  }
}

function extractLabeledResults(text: string): WebSearchProviderResult[] {
  return text
    .split(/\n\s*\n/)
    .map((chunk) => {
      const title = chunk.match(/^Title:\s*(.+)$/im)?.[1]?.trim()
      const rawUrl = chunk.match(/^URL:\s*(https?:\/\/\S+)$/im)?.[1]
      const content = chunk.match(/^Text:\s*([\s\S]*)$/im)?.[1]?.trim()
      const url = rawUrl ? normalizeUrl(rawUrl) : undefined
      return url
        ? {
            title: title || new URL(url).hostname,
            content: trimContent(content),
            url
          }
        : undefined
    })
    .filter((result): result is WebSearchProviderResult => Boolean(result))
}

function extractStringResults(text: string): WebSearchProviderResult[] {
  const results = extractLabeledResults(text)

  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const url = normalizeUrl(match[2])
    if (url) {
      results.push({ title: match[1].trim() || new URL(url).hostname, content: '', url })
    }
  }

  for (const rawUrl of text.match(URL_PATTERN) || []) {
    const url = normalizeUrl(rawUrl)
    if (url) {
      results.push({ title: new URL(url).hostname, content: '', url })
    }
  }

  return results
}

function collectResults(value: unknown, depth = 0): WebSearchProviderResult[] {
  if (depth > 5 || value === null || value === undefined) return []

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 2_000_000) {
      try {
        return collectResults(JSON.parse(trimmed), depth + 1)
      } catch {
        // The value is regular text rather than JSON.
      }
    }
    return extractStringResults(value)
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectResults(item, depth + 1))
  }

  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>
    const directResult = resultFromObject(objectValue)
    const nestedResults = Object.values(objectValue).flatMap((item) => collectResults(item, depth + 1))
    return directResult ? [directResult, ...nestedResults] : nestedResults
  }

  return []
}

export function isTraceableWebTool(toolName: string): boolean {
  return WEB_TOOL_NAME_PATTERN.test(toolName)
}

export function extractWebCitationResults(toolResponse: ToolResponse): WebSearchProviderResult[] {
  if (!isTraceableWebTool(toolResponse.tool.name)) return []

  const results = [...collectResults(toolResponse.response), ...collectResults(toolResponse.arguments)]
  const deduplicated = new Map<string, WebSearchProviderResult>()

  for (const result of results) {
    const existing = deduplicated.get(result.url)
    if (!existing || (!existing.content && result.content)) {
      deduplicated.set(result.url, result)
    }
  }

  return Array.from(deduplicated.values()).slice(0, MAX_CITATION_RESULTS)
}
