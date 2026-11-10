import { createHmac, randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { ContextSourceAudit } from '../contextSourceAudit'

const audit = () => {
  const key = randomBytes(32)
  return new ContextSourceAudit((text) => createHmac('sha256', key).update(text).digest('hex'))
}

describe('context source observation', () => {
  it('separates instructions, tools, user and source text without exporting their contents', () => {
    const excerpt = JSON.stringify({ text: 'PRIVATE 中文原文', source_url: 'https://private.example/?key=SECRET' })
    const body = {
      messages: [
        { role: 'system', content: 'PRIVATE SYSTEM' },
        { role: 'user', content: 'PRIVATE USER' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'secret-call', function: { name: 'mcp__assistant__read_webpage', arguments: '{}' } }]
        },
        { role: 'tool', tool_call_id: 'secret-call', content: excerpt },
        { role: 'tool', tool_call_id: 'secret-call', content: excerpt }
      ],
      tools: [{ private_schema: 'SECRET SCHEMA' }]
    }
    const observer = audit()
    const first = observer.inspect(body)
    expect(first.categories.instructions.items).toBe(1)
    expect(first.categories.user.items).toBe(1)
    expect(first.tools.read_webpage.items).toBe(2)
    expect(first.categories.toolResults.jsonBytes).toBeGreaterThan(first.categories.toolResults.jsonCharacters)
    expect(first.categories.assistant.jsonCharacters).toBe(
      'null'.length + JSON.stringify(body.messages[2].tool_calls).length
    )
    expect(first.repeatedToolJsonCharacters).toBe(JSON.stringify(excerpt).length)
    expect(first.repeatedExcerptCharacters).toBe('PRIVATE 中文原文'.length)
    expect(first.carriedToolJsonCharacters).toBe(0)
    expect(observer.inspect(body).carriedToolJsonCharacters).toBe(first.categories.toolResults.jsonCharacters)
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE|SECRET|private\.example|secret-call|原文/)
    expect(audit().inspect(body).largest[0].fingerprint).not.toBe(first.largest[0].fingerprint)
    expect(
      observer.inspect({ messages: [{ role: 'user', content: 'Compacted findings' }] }).tools.read_webpage.items
    ).toBe(0)
  })

  it('identifies Anthropic and Responses tool results and preserves distinct PDF excerpts', () => {
    const anthropic = audit().inspect({
      system: [{ type: 'text', text: 'system' }],
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read_paper', input: {} }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: '{"text":"Page one"}' }] }]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: '{"text":"Page two"}' }] }]
        }
      ]
    })
    expect(anthropic.tools.read_paper.items).toBe(2)
    expect(anthropic.categories.user.items).toBe(0)
    expect(anthropic.repeatedExcerptCharacters).toBe(0)
    const responses = audit().inspect({
      instructions: 'system',
      input: [
        { type: 'function_call', call_id: 'b', name: 'mcp__assistant__web_search', arguments: '{}' },
        { type: 'function_call_output', call_id: 'b', output: 'search result' },
        { role: 'user', content: [{ type: 'input_text', text: 'question' }] }
      ]
    })
    expect(responses.tools.web_search.items).toBe(1)
    expect(responses.categories.instructions.items).toBe(1)
    expect(responses.categories.user.items).toBe(1)
  })

  it('reports limited coverage and a bounded contributor list for excessive message counts', () => {
    const result = audit().inspect({ input: Array.from({ length: 4100 }, () => ({ role: 'user', content: 'test' })) })
    expect(result.coverage).toBe('limited')
    expect(result.categories.user.items).toBe(4096)
    expect(result.largest).toHaveLength(8)
    expect(JSON.stringify(result).length).toBeLessThan(6000)
  })

  it('compares cached PDF excerpts at their source/page location instead of treating different pages as repeats', () => {
    const result = (section: number, cached = false) =>
      JSON.stringify({
        source_url: 'https://source.example/paper.pdf',
        cached,
        chunks: [{ section, char_start: 0, char_end: 9, text: 'Same text' }]
      })
    const response = audit().inspect({
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'read_paper' } }] },
        ...[result(1), result(2), result(1, true)].map((content) => ({ role: 'tool', tool_call_id: 'a', content }))
      ]
    })
    expect(response.repeatedExcerptCharacters).toBe('Same text'.length)
    expect(response.repeatedToolJsonCharacters).toBe(0)
    expect(response.categories.assistant.jsonCharacters).toBe(
      JSON.stringify([{ id: 'a', function: { name: 'read_paper' } }]).length
    )
  })
})
