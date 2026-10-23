import { describe, expect, it } from 'vitest'

import { serializeAgentStreamError } from '../streamError'

describe('agent stream error serialization', () => {
  it('preserves native diagnostic fields while redacting messages, stacks and nested causes', () => {
    const error = Object.assign(new Error('socket closed Bearer fixture-secret'), {
      name: 'ProviderHeaderTimeoutError',
      code: 'ECONNRESET',
      zenTraceId: 'trace-safe',
      cause: { message: 'https://user:pass@example.com/v1?key=fixture-secret', authorization: 'fixture-secret' }
    })
    const result = serializeAgentStreamError(error)
    expect(result).toMatchObject({
      name: error.name,
      code: 'ECONNRESET',
      zenTraceId: 'trace-safe',
      message: 'socket closed Bearer [REDACTED]',
      cause: { message: 'https://example.com/v1', authorization: '[REDACTED]' }
    })
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
  })

  it('accepts serialized errors and strings without replacing their messages', () => {
    expect(
      serializeAgentStreamError({ name: 'NativeError', message: 'headers timed out', code: 'TIMEOUT' })
    ).toMatchObject({ name: 'NativeError', message: 'headers timed out', code: 'TIMEOUT' })
    expect(serializeAgentStreamError('socket closed')).toEqual({ message: 'socket closed' })
    expect(serializeAgentStreamError(undefined, 'No error details')).toEqual({ message: 'No error details' })
  })
})
