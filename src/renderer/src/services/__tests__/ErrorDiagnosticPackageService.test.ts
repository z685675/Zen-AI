import i18n from '@renderer/i18n'
import type { Message } from '@renderer/types/newMessage'
import { diagnoseClientError } from '@renderer/utils/clientErrorDiagnosis'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { beginDiagnostic, recordDiagnostic } from '../DiagnosticEvidenceService'
import {
  exportErrorDiagnosticPackage,
  redactDiagnosticValue,
  safeDiagnosticJson
} from '../ErrorDiagnosticPackageService'

vi.mock('@renderer/store', () => ({ default: { getState: () => ({ llm: { providers: [] } }) } }))

describe('ErrorDiagnosticPackageService', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('zh-CN')
  })
  it.each(['chat', 'agent'] as const)(
    'exports a successful %s turn with timings but no private content by default at the new entry',
    async (source) => {
      const original = window.api
      const save = vi.fn(async () => '/success.zip')
      Object.assign(window, {
        api: {
          file: {
            collectDiagnosticEvidence: async () => ({
              snapshotStatus: 'collected',
              evidence: {
                operationId: 'turn',
                startedAt: '2026-10-24T00:00:00Z',
                updatedAt: '2026-10-24T00:00:05Z',
                droppedEvents: 0,
                metadata: { prompt: 'PRIVATE_RUNTIME_PROMPT' },
                events: [
                  {
                    at: '2026-10-24T00:00:01Z',
                    stage: 'tool',
                    event: 'tool-call',
                    details: { toolCallId: 'tool', toolName: 'read', arguments: 'PRIVATE_ARGUMENT' }
                  },
                  {
                    at: '2026-10-24T00:00:02Z',
                    stage: 'tool',
                    event: 'tool-result',
                    details: { toolCallId: 'tool', result: 'PRIVATE_RESULT' }
                  }
                ]
              },
              logs: [{ message: 'PRIVATE_LOG' }]
            }),
            saveDiagnosticPackage: save
          }
        }
      })
      try {
        beginDiagnostic(`successful-${source}`, {
          prompt: 'PRIVATE_PROMPT',
          settings: { instructions: 'PRIVATE_SETTINGS' }
        })
        recordDiagnostic(`successful-${source}`, 'response', 'first-text')
        const reply = {
          id: `successful-${source}`,
          role: 'assistant',
          blocks: ['a'],
          status: 'success',
          topicId: 'topic',
          usage: { prompt_tokens: 130000, completion_tokens: 100, cached_tokens: 120000 },
          providerMetadata: {
            responseTiming: {
              startedAt: '2026-10-24T00:00:00Z',
              finishedAt: '2026-10-24T00:00:05Z',
              elapsedMs: 5000,
              outcome: 'completed'
            },
            private: 'PRIVATE_METADATA'
          }
        } as unknown as Message
        await exportErrorDiagnosticPackage({
          source,
          message: reply,
          relatedUserMessage: { id: 'u', role: 'user', blocks: ['u'] } as Message,
          blockEntities: {
            a: { type: 'main_text', content: 'PRIVATE_ANSWER' },
            u: { type: 'main_text', content: 'PRIVATE_QUESTION' }
          } as any,
          includeContent: false,
          title: 'snapshot',
          description: 'success',
          privacyNotice: 'privacy',
          sessionContext: { secretPrompt: 'PRIVATE_SESSION' }
        })
        const files = save.mock.calls[0][1] as unknown as Array<{ path: string; content: string }>
        const joined = files.map((file) => file.content).join('\n')
        expect(joined).not.toContain('PRIVATE_')
        expect(files.some((file) => file.path === '本轮耗时报告.md')).toBe(true)
        expect(files.some((file) => file.path === 'performance.json')).toBe(true)
        expect(files.some((file) => file.path === 'diagnosis.json')).toBe(false)
        expect(files.some((file) => file.path === 'session-context.json')).toBe(false)
        expect(joined).toContain('输入 130000；输出 100；缓存读取 120000')
        expect(JSON.parse(files.find((file) => file.path === 'summary.json')!.content)).toMatchObject({
          mode: 'snapshot',
          includeContent: false,
          observation: { messageStatus: 'success' }
        })
      } finally {
        Object.assign(window, { api: original })
      }
    }
  )
  it('exports an active conversation snapshot without inventing an error or diagnosis', async () => {
    const original = window.api
    const save = vi.fn(async () => '/snap.zip')
    Object.assign(window, {
      api: {
        file: {
          collectDiagnosticEvidence: async () => ({ snapshotStatus: 'unavailable' }),
          saveDiagnosticPackage: save
        }
      }
    })
    try {
      await exportErrorDiagnosticPackage({
        source: 'agent',
        title: 'snapshot',
        description: 'state only',
        privacyNotice: 'private',
        message: {
          id: 'running-turn',
          role: 'assistant',
          topicId: 'agent-session:session',
          blocks: [],
          status: 'processing'
        } as unknown as Message
      })
      const files = save.mock.calls[0][1] as unknown as Array<{ path: string; content: string }>
      const summary = JSON.parse(files.find((file) => file.path === 'summary.json')!.content)
      expect(summary).toMatchObject({
        mode: 'snapshot',
        observation: { messageStatus: 'processing', automaticReplay: false }
      })
      expect(summary.issue.category).toBeUndefined()
      expect(files.some((file) => file.path === 'task-status.json')).toBe(true)
      expect(files.some((file) => file.path === 'diagnosis.json')).toBe(false)
      expect(summary.attribution.owner).toBe('undetermined')
      expect(files.find((file) => file.path === '链路结论.txt')!.content).toContain(
        i18n.t('error.diagnosis.chain_observation_line', { owner: '未确认' })
      )
    } finally {
      Object.assign(window, { api: original })
    }
  })
  it('does not leak raw diagnosis or connectivity content when metadata-only is explicitly requested', async () => {
    const original = window.api
    const save = vi.fn(async () => '/metadata.zip')
    Object.assign(window, {
      api: {
        file: {
          collectDiagnosticEvidence: async () => ({ snapshotStatus: 'unavailable' }),
          saveDiagnosticPackage: save
        }
      }
    })
    try {
      const error = {
        name: 'Error',
        message: 'PRIVATE_ERROR',
        stack: null,
        zenConnectivityCheck: { error: 'PRIVATE_CONNECTIVITY' }
      }
      await exportErrorDiagnosticPackage({
        source: 'chat',
        title: 'snapshot',
        description: 'metadata',
        privacyNotice: 'privacy',
        message: { id: 'metadata-diagnosis', role: 'assistant', topicId: 'topic', blocks: [] } as unknown as Message,
        error,
        diagnosis: diagnoseClientError(error),
        includeContent: false
      })
      const files = save.mock.calls[0][1] as unknown as Array<{ path: string; content: string }>
      expect(files.some((file) => file.path === 'diagnosis.json')).toBe(false)
      expect(files.map((file) => file.content).join('\n')).not.toContain('PRIVATE_')
    } finally {
      Object.assign(window, { api: original })
    }
  })
  it.each([true, false])(
    'exports a dedicated native runtime file with explicit evidence status (observed=%s)',
    async (observed) => {
      const original = window.api
      const save = vi.fn(async () => 'C:/fake/native.zip')
      const events = observed
        ? [
            {
              at: '2026-10-12T00:00:00Z',
              stage: 'runtime',
              event: 'process-snapshot',
              details: { runtime: 'opencode', stderr: { text: 'fatal error api_key=raw-secret' } }
            },
            {
              at: '2026-10-12T00:00:01Z',
              stage: 'runtime',
              event: 'process-exit',
              details: { runtime: 'opencode', code: 7, unexpected: true, active: true }
            }
          ]
        : []
      Object.assign(window, {
        api: {
          file: {
            collectDiagnosticEvidence: async () => ({
              snapshotStatus: observed ? 'collected' : 'unavailable',
              evidence: observed ? { events } : undefined,
              environment: {
                executables: { opencode: { expectedVersion: '1.18.35', exists: true } },
                componentVersions: { 'opencode-ai': '1.18.35' }
              }
            }),
            saveDiagnosticPackage: save
          }
        }
      })
      try {
        await exportErrorDiagnosticPackage({
          source: 'agent',
          title: 'test',
          description: 'test',
          classification: { category: 'unknown' } as never,
          diagnosis: diagnoseClientError({ name: 'Error', message: 'test', stack: null }),
          message: {
            id: `native-export-${observed}`,
            topicId: 'session',
            blocks: [],
            role: 'assistant'
          } as unknown as Message,
          privacyNotice: 'test privacy'
        })
        const files = save.mock.calls[0][1] as unknown as Array<{ path: string; content: string }>
        const native = JSON.parse(files.find((file) => file.path === 'opencode-runtime.json')!.content)
        expect(native).toMatchObject({
          schemaVersion: 1,
          status: observed ? 'observed-current-operation' : 'no-operation-runtime-evidence',
          environmentAtExportTime: { snapshotTime: 'export-time' }
        })
        expect(native.events).toHaveLength(events.length)
        const summary = JSON.parse(files.find((file) => file.path === 'summary.json')!.content)
        expect(summary.attribution.owner).toBe(observed ? 'zen-ai' : 'undetermined')
        expect(files.map((file) => file.content).join('\n')).not.toContain('raw-secret')
        expect(files.map((file) => file.content).join('\n')).not.toContain('OPENCODE_CONFIG_CONTENT')
      } finally {
        Object.assign(window, { api: original })
      }
    }
  )
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
      expect(files.find((entry) => entry.path === '链路结论.txt')!.content).toContain(
        i18n.t('error.diagnosis.chain_error_line', { owner: 'Zen AI 客户端' })
      )
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
