import type { Message, MessageBlock } from '@renderer/types/newMessage'
import type { DiagnosticEvent } from '@shared/diagnostics'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  createTurnReport,
  metadataBackend,
  metadataBlock,
  metadataEvent,
  metadataMessage
} from '../TurnDiagnosticReport'

describe('turn report metadata privacy', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('zh-CN')
  })
  it('keeps safe timing, usage and error class but never unknown or nested content fields', () => {
    const privateValue = 'PRIVATE_CONTENT'
    const message = metadataMessage({
      id: 'a',
      role: 'assistant',
      usage: { prompt_tokens: 3, secret: privateValue, prompt_tokens_details: { cached_tokens: 2, raw: privateValue } },
      metrics: { completion_tokens: 1, unknown: privateValue },
      providerMetadata: { responseTiming: { elapsedMs: 100, unknown: privateValue } }
    } as unknown as Message)
    const event = metadataEvent({
      at: '2026-10-24T00:00:00Z',
      stage: 'response',
      event: 'failed',
      details: {
        error: { name: 'AI_APICallError', message: privateValue, stack: privateValue },
        toolCallId: 't',
        arguments: privateValue
      }
    })
    const block = metadataBlock({
      type: 'file',
      content: privateValue,
      file: { size: 123, ext: '.pdf', name: privateValue, path: privateValue }
    } as unknown as MessageBlock)
    expect(JSON.stringify({ message, event, block })).not.toContain(privateValue)
    expect(message?.usage).toMatchObject({ prompt_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } })
    expect(event.details?.error).toEqual({ name: 'AI_APICallError' })
    expect(block?.attachment).toMatchObject({ size: 123, ext: '.pdf' })
  })
  it('retains bounded backend channel attempts and delivery evidence, not payloads', () => {
    const backend = metadataBackend({
      requestId: 'api-1',
      failureStage: 'downstream-delivery',
      writtenBytes: 1024,
      raw: 'PRIVATE_BODY',
      attempts: Array.from({ length: 70 }, (_, index) => ({
        index,
        channelId: 11,
        durationMs: 300,
        outcome: 'succeeded',
        status: 200,
        prompt: 'PRIVATE_BODY',
        response: 'PRIVATE_BODY'
      }))
    })
    expect(backend).toMatchObject({ requestId: 'api-1', failureStage: 'downstream-delivery', writtenBytes: 1024 })
    expect(backend.attempts).toHaveLength(64)
    expect(backend.attempts?.[0]).toMatchObject({ channelId: 11, durationMs: 300, status: 200 })
    expect(JSON.stringify(backend)).not.toContain('PRIVATE_BODY')
  })
  it('does not mix response-only timings with the earlier preparation clock', () => {
    const message = {
      status: 'success',
      providerMetadata: {
        responseTiming: {
          startedAt: '2026-10-24T00:00:10Z',
          finishedAt: '2026-10-24T00:00:15Z',
          elapsedMs: 5000,
          firstTokenMs: 2000,
          outcome: 'completed'
        }
      }
    } as unknown as Message
    const events: DiagnosticEvent[] = [{ at: '2026-10-24T00:00:12Z', stage: 'response', event: 'first-content' }]
    const { performance, summary } = createTurnReport(message, events, '2026-10-24T00:00:00Z')
    expect(performance).toMatchObject({ totalMs: 15000, firstContentMs: 12000, firstTextMs: null })
    expect(summary).toContain('首次正文：未记录或尚未结束')
    expect(summary).toContain('first-answer-text')
  })
})
import i18n from '@renderer/i18n'

it('recovers historical counts and safe totals without inventing missing intervals', () => {
  const diagnostics = {
    version: 1,
    providerId: 'p',
    modelId: 'm',
    usage: { input: 753067, output: 6958 },
    observedRequests: 25,
    reportedRequests: 24,
    inputReports: 24,
    outputReports: 24,
    cacheReadReports: 24,
    cacheWriteReports: 0,
    incompleteRequests: 0,
    performance: {
      outcome: 'completed',
      totalMs: 617996,
      preparationMs: 5,
      upstreamRequests: 25,
      upstreamHeaderWaitMs: 537014,
      upstreamRequestMs: 550042,
      retryEvents: 1,
      toolCalls: 23,
      completedToolObservedMs: 6473,
      unfinishedTools: 0
    },
    secret: 'PRIVATE_CONTENT'
  }
  const message = { status: 'success', providerMetadata: { opencodeDiagnostics: diagnostics } } as unknown as Message
  const { performance, summary } = createTurnReport(message, [])
  expect(performance).toMatchObject({
    observedRequests: 25,
    toolCalls: 23,
    retryEvents: 1,
    aggregate: { upstreamRequestMs: 550042 }
  })
  expect(performance.intervals).toEqual([])
  expect(performance.coverage.missing).toContain('per-request-or-tool-timeline-unavailable-aggregate-only')
  expect(summary).toContain('550.04s')
  expect(JSON.stringify(metadataMessage(message))).not.toContain('PRIVATE_CONTENT')
  expect(metadataMessage(message)?.opencodeDiagnostics?.observedRequests).toBe(25)
})

it('reports unavailable counts instead of zero when all evidence is missing', () => {
  const { performance } = createTurnReport({ status: 'success' } as Message, [])
  expect(performance).toMatchObject({ observedRequests: null, toolCalls: null, retryEvents: null, aggregate: null })
})

it('retains a safe local deadline cause in metadata-only exports without error text', () => {
  const event = metadataEvent({
    at: '2026-10-26T00:00:00Z',
    stage: 'response',
    event: 'failed',
    details: {
      error: {
        name: 'AI_ProviderSpecificError',
        message: 'PRIVATE_CONTENT',
        cause: { code: 'agent_human_wait_timeout', zenFailureStage: 'local-task-deadline', message: 'PRIVATE_CONTENT' }
      }
    }
  })
  expect(event.details?.error).toMatchObject({
    cause: { code: 'agent_human_wait_timeout', zenFailureStage: 'local-task-deadline' }
  })
  expect(JSON.stringify(event)).not.toContain('PRIVATE_CONTENT')
})
