import type { Message } from '@renderer/types/newMessage'
import { diagnoseClientError } from '@renderer/utils/clientErrorDiagnosis'
import { describe, expect, it, vi } from 'vitest'

import { beginDiagnostic, recordDiagnostic } from '../DiagnosticEvidenceService'
import {
  exportErrorDiagnosticPackage,
  redactDiagnosticValue,
  safeDiagnosticJson
} from '../ErrorDiagnosticPackageService'

vi.mock('@renderer/store', () => ({ default: { getState: () => ({ llm: { providers: [] } }) } }))

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
    const serialized = safeDiagnosticJson({ content: 'x'.repeat(12000) })

    expect(serialized).toContain('...[truncated')
    expect(serialized.length).toBeLessThan(8500)
  })
  it('exports evidence, provenance and explicit missing collectors instead of silently omitting them', async () => {
    const original = window.api
    const save = vi.fn(async () => 'C:/fake/diagnostics.zip')
    Object.assign(window, {
      api: {
        file: {
          collectDiagnosticEvidence: async () => {
            throw new Error('main unavailable')
          },
          saveDiagnosticPackage: save
        }
      }
    })
    try {
      beginDiagnostic('export-message', { source: 'chat' })
      recordDiagnostic('export-message', 'preparation', 'failed', { error: new Error('attachment parser failed') })
      const error = { name: 'Error', message: 'attachment parser failed', stack: null, apiKey: 'fake-secret' }
      await exportErrorDiagnosticPackage({
        source: 'chat',
        title: 'test',
        description: 'test',
        classification: { category: 'unknown' } as never,
        diagnosis: diagnoseClientError(error),
        error,
        message: { id: 'export-message', topicId: 'topic', blocks: [], role: 'assistant' } as unknown as Message,
        privacyNotice: 'test privacy'
      })
      const files = save.mock.calls[0][1] as unknown as Array<{ path: string; content: string }>
      const file = (path: string) => JSON.parse(files.find((item) => item.path === path)!.content)
      expect(file('summary.json')).toMatchObject({
        schemaVersion: 3,
        attribution: { owner: 'zen-ai', confidence: 'confirmed' }
      })
      expect(file('collection-manifest.json').collections).toMatchObject({
        main: 'main unavailable',
        zenApi: 'provider-or-key-unavailable',
        userMessage: 'not-loaded-or-unavailable'
      })
      expect(files.some((entry) => entry.path === 'timeline.json')).toBe(true)
      expect(files.map((entry) => entry.content).join('\n')).not.toContain('fake-secret')
    } finally {
      Object.assign(window, { api: original })
    }
  })
})
