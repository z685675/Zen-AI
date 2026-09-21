import { describe, expect, it } from 'vitest'

import { redactDiagnosticValue, safeDiagnosticJson } from '../ErrorDiagnosticPackageService'

describe('ErrorDiagnosticPackageService', () => {
  it('redacts credential fields and query parameters', () => {
    const value = redactDiagnosticValue({
      apiKey: 'secret-key',
      authorization: 'Bearer secret-token',
      requestUrl: 'https://example.com/v1/chat/completions?key=secret-key',
      message: 'Authorization: "secret-token"'
    })

    expect(value).toEqual({
      apiKey: '[REDACTED]',
      authorization: '[REDACTED]',
      requestUrl: 'https://example.com/v1/chat/completions',
      message: 'Authorization: [REDACTED]'
    })
  })

  it('keeps diagnostic JSON serializable and truncates oversized strings', () => {
    const serialized = safeDiagnosticJson({ content: 'x'.repeat(5000) })

    expect(serialized).toContain('...[truncated]')
    expect(serialized.length).toBeLessThan(4500)
  })
})
