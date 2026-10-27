import { describe, expect, it } from 'vitest'

import { createAssistantToolFailure, readAssistantToolFailure } from './toolFailure'

describe('assistant tool failure guidance', () => {
  it.each([
    ['permission denied', 'permission'],
    ['Overwrite was not approved', 'permission'],
    ['File already exists', 'file_busy'],
    ['File changed while awaiting approval', 'file_busy'],
    ['Cannot back up a missing file', 'missing_file'],
    ['Office quality validation: visible content missing', 'validation'],
    ['formula requires an explicit finite result', 'validation'],
    ['Managed Python runtime is unavailable', 'runtime'],
    ['No supported Office renderer', 'runtime'],
    ['Search service is rate limited', 'rate_limit'],
    ['Request timed out', 'timeout'],
    ['fetch failed', 'network'],
    ['A file_path is required', 'invalid_input'],
    ["'file_paths' must contain at least one file path", 'invalid_input'],
    ['unclassified failure', 'unknown']
  ])('classifies observed %s without executing anything', (message, code) => {
    expect(createAssistantToolFailure('create_file', new Error(message))).toMatchObject({
      code,
      automatic_retry: false
    })
  })

  it('distinguishes a missing Python dependency from runtime startup and respects cancellation', () => {
    const message = "ModuleNotFoundError: No module named 'unknown_package'"
    expect(createAssistantToolFailure('python_execute', message).code).toBe('dependency')
    expect(createAssistantToolFailure('create_file', message).code).toBe('unknown')
    expect(createAssistantToolFailure('python_execute', message, true).code).toBe('cancelled')
    expect(
      createAssistantToolFailure('create_file', Object.assign(new Error('stop'), { name: 'AbortError' })).code
    ).toBe('cancelled')
    expect(createAssistantToolFailure('create_file', Object.assign(new Error('read'), { code: 'ENOENT' })).code).toBe(
      'missing_file'
    )
  })

  it('accepts the MCP result, native JSON error, and persisted message wrapper', () => {
    const failure = createAssistantToolFailure('create_file', 'Office quality validation failed')
    const text = JSON.stringify({ status: 'failed', failure })
    for (const value of [failure, text, { content: [{ type: 'text', text }] }, { error: text }, new Error(text)]) {
      expect(readAssistantToolFailure(value)).toEqual(failure)
    }
  })

  it('rejects arbitrary text, unsupported versions, malformed envelopes and unbounded nesting', () => {
    const failure = createAssistantToolFailure('create_file', 'failure')
    for (const value of [
      'Error: failure',
      'x'.repeat(40_001),
      { ...failure, version: 2 },
      { ...failure, code: 'made_up' },
      { ...failure, automatic_retry: true },
      { ...failure, tool: 'x'.repeat(201) },
      { ...failure, details: null },
      { message: { message: { message: { message: { message: failure } } } } }
    ]) {
      expect(readAssistantToolFailure(value)).toBeUndefined()
    }
    const circular: Record<string, unknown> = {}
    circular.error = circular
    expect(readAssistantToolFailure(circular)).toBeUndefined()
  })

  it('redacts credentials and bounds displayed details even from persisted envelopes', () => {
    const failure = createAssistantToolFailure(
      'web_search',
      'fetch failed https://user:secret@example.com/a?token=secret Bearer hidden-secret sk-123456789secret'
    )
    expect(failure.details).not.toMatch(/hidden-secret|123456789secret|user:secret|token=secret/)
    const parsed = readAssistantToolFailure({ ...failure, details: 'password=secret ' + 'x'.repeat(30_000) })!
    expect(parsed.details).not.toContain('password=secret')
    expect(parsed.details.length).toBeLessThan(8200)
  })
})
