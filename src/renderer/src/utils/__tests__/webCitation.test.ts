import { describe, expect, it } from 'vitest'

import { extractWebCitationResults, isTraceableWebTool } from '../webCitation'

describe('webCitation', () => {
  it('recognizes AI chat and agent web tools', () => {
    expect(isTraceableWebTool('builtin_web_search')).toBe(true)
    expect(isTraceableWebTool('mcp__exa__web_search_exa')).toBe(true)
    expect(isTraceableWebTool('mcp__browser__open')).toBe(true)
    expect(isTraceableWebTool('codex.web_search')).toBe(true)
    expect(isTraceableWebTool('mcp__assistant__read_webpage')).toBe(true)
    expect(isTraceableWebTool('mcp__assistant__create_file')).toBe(false)
  })

  it('cites only a successfully extracted webpage, not unread links or the requested redirect URL', () => {
    const response = {
      id: 'source-read',
      toolCallId: 'source-read',
      status: 'done' as const,
      tool: { name: 'mcp__assistant__read_webpage' } as any,
      arguments: { url: 'https://example.com/old' },
      response: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'partial',
              source_url: 'https://example.com/old',
              resolved_url: 'https://example.com/current',
              title: 'Extracted source',
              text: 'Evidence and [unread link](https://unread.example/)'
            })
          }
        ]
      }
    }
    expect(extractWebCitationResults(response)).toEqual([
      {
        title: 'Extracted source',
        url: 'https://example.com/current',
        content: 'Evidence and [unread link](https://unread.example/)'
      }
    ])
    expect(extractWebCitationResults({ ...response, status: 'error' })).toEqual([])
    expect(
      extractWebCitationResults({ ...response, response: { isError: true, content: response.response.content } })
    ).toEqual([])
    expect(
      extractWebCitationResults({
        ...response,
        response: { status: 'failed', url: response.arguments.url, text: 'HTTP 403' }
      })
    ).toEqual([])
  })

  it('extracts structured search results', () => {
    const results = extractWebCitationResults({
      id: 'tool-1',
      toolCallId: 'tool-1',
      status: 'done',
      tool: { name: 'builtin_web_search' } as any,
      arguments: {},
      response: {
        query: 'latest',
        results: [
          {
            title: 'Example',
            url: 'https://example.com/article',
            content: 'Current information'
          }
        ]
      }
    })

    expect(results).toEqual([
      {
        title: 'Example',
        url: 'https://example.com/article',
        content: 'Current information'
      }
    ])
  })

  it('preserves the primary search result URL when provider metadata contains a different source URL', () => {
    const results = extractWebCitationResults({
      id: 'search-metadata',
      toolCallId: 'search-metadata',
      status: 'done',
      tool: { name: 'builtin_web_search' } as any,
      arguments: {},
      response: {
        title: 'Original source',
        url: 'https://example.com/article',
        source_url: 'https://search-provider.example/metadata'
      }
    })
    expect(results[0]).toMatchObject({ title: 'Original source', url: 'https://example.com/article' })
  })

  it('extracts and deduplicates Exa-style labeled text', () => {
    const results = extractWebCitationResults({
      id: 'tool-2',
      toolCallId: 'tool-2',
      status: 'done',
      tool: { name: 'mcp__exa__web_search_exa' } as any,
      arguments: {},
      response: 'Title: Source A\nURL: https://example.com/a\nText: useful text\n\n[Source A](https://example.com/a)'
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      title: 'Source A',
      url: 'https://example.com/a',
      content: 'useful text'
    })
  })
})
