import { describe, expect, it } from 'vitest'

import type { DiagnosticEvent } from '../diagnostics'
import { buildToolArgumentReport, formatToolArgumentReport } from '../toolArgumentReport'

const event = (phase: string, fields: Record<string, unknown> = {}): DiagnosticEvent => ({
  at: '2026-11-05T00:00:00Z',
  stage: 'transport',
  event: 'tool-arguments',
  details: {
    phase,
    nativeToolCallId: 'call-1',
    toolName: 'mcp__assistant__create_file',
    argumentFingerprint: 'keyed-digest',
    argumentComplete: true,
    ...fields
  }
})
describe('per-call tool argument diagnosis', () => {
  it('distinguishes API conversion changes from arguments that were already empty upstream', () => {
    const row = {
      callId: 'call-1',
      tool: 'mcp__assistant__create_file',
      state: 'object',
      bytes: 20,
      keys: 1,
      complete: true,
      fingerprint: 'a'.repeat(64)
    }
    const backend = [
      {
        requestId: 'server-1',
        attempts: [
          {
            channelId: 36,
            timing: {
              startedAt: '2026-11-05T00:00:00Z',
              toolArgumentAuditVersion: 1,
              toolArguments: [
                { ...row, source: 'upstream-raw' },
                { ...row, source: 'client-forward', state: 'empty-object', keys: 0, fingerprint: 'b'.repeat(64) }
              ]
            }
          }
        ]
      }
    ]
    const report = buildToolArgumentReport([event('provider-wire', { requestId: 'server-1' })], backend)
    expect(report.serverCalls[0].finding).toBe('changed-inside-api')
    expect(report.calls[0].server).toHaveLength(1)
    backend[0].attempts[0].timing.toolArguments[0].fingerprint = 'b'.repeat(64)
    expect(buildToolArgumentReport([], backend).serverCalls[0].finding).toBe('api-boundaries-consistent')
    backend[0].attempts[0].timing.toolArguments[0].complete = false
    expect(buildToolArgumentReport([], backend).serverCalls[0].finding).toBe('insufficient')
  })
  it('finds required arguments already missing at the client boundary without blaming upstream raw output', () => {
    const report = buildToolArgumentReport([
      event('provider-wire', { missingRequiredKeys: 1 }),
      event('native-decoded')
    ])
    expect(report.calls[0].finding).toBe('missing-at-provider-boundary')
    expect(formatToolArgumentReport(report)).toContain('继续核查 API 转换与上游输出')
  })
  it('finds changed decoded arguments only with an exact call ID and a complete observation', () => {
    const report = buildToolArgumentReport([
      event('provider-wire'),
      event('native-decoded', { argumentFingerprint: 'different' })
    ])
    expect(report.calls[0].finding).toBe('changed-before-native-execution')
    for (const difference of [{ nativeToolCallId: 'other-call' }, { argumentComplete: false }]) {
      expect(
        buildToolArgumentReport([
          event('provider-wire', difference),
          event('native-decoded', { argumentFingerprint: 'different' })
        ]).calls[0].finding
      ).toBe('insufficient')
    }
  })
  it('leaves repeated identical MCP inputs ambiguous instead of pairing unrelated calls', () => {
    const report = buildToolArgumentReport([
      event('provider-wire'),
      event('native-decoded'),
      event('native-decoded', { nativeToolCallId: 'call-2' }),
      event('mcp-execution', { executionRequestId: 'rpc-1' })
    ])
    expect(report.calls[0].execution).toBeUndefined()
    expect(report.calls[0].executionCorrelation).toBe('ambiguous-identical-inputs')
    const unique = buildToolArgumentReport([
      event('provider-wire'),
      event('native-decoded'),
      event('mcp-execution', { executionRequestId: 'rpc-1' })
    ])
    expect(unique.calls[0].executionCorrelation).toBe('unique-name-and-fingerprint')
  })
  it('reports old-main evidence as absent, never silently assumes the patch was running', () => {
    const report = buildToolArgumentReport([])
    expect(report.runtimeCapabilities).toEqual({ toolArgumentAuditVersion: null, loopRecoveryVersion: null })
    expect(formatToolArgumentReport(report)).toContain('完整重启客户端主进程')
  })
})
