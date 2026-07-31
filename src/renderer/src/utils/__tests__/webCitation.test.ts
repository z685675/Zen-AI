import { describe, expect, it } from 'vitest'

import { extractWebCitationResults, isTraceableWebTool } from '../webCitation'

describe('webCitation', () => {
  it('recognizes AI chat and agent web tools', () => {
    expect(isTraceableWebTool('builtin_web_search')).toBe(true)
    expect(isTraceableWebTool('mcp__exa__web_search_exa')).toBe(true)
    expect(isTraceableWebTool('mcp__browser__open')).toBe(true)
    expect(isTraceableWebTool('codex.web_search')).toBe(true)
    expect(isTraceableWebTool('mcp__assistant__create_file')).toBe(false)
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
