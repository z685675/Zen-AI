import { describe, expect, it } from 'vitest'

import { collectRuntimeSecrets, OPENCODE_STDERR_LIMITS, OpenCodeStderr } from '../stderr'

describe('bounded native stderr diagnostics', () => {
  it('redacts UTF8 and credentials split across pipe chunks, including unlabelled configured credentials', () => {
    const stderr = new OpenCodeStderr(['opaque-runtime-password', 'opaque-custom-header'])
    const bytes = Buffer.from('中文错误 Authorization: Bearer abc-def\nopaque-runtime-password opaque-custom-header\n')
    for (const byte of bytes) stderr.append(Buffer.from([byte]))
    const result = stderr.snapshot()
    expect(result.text).toContain('中文错误')
    for (const secret of ['abc-def', 'opaque-runtime-password', 'opaque-custom-header'])
      expect(result.text).not.toContain(secret)
    expect(result.observedBytes).toBe(bytes.length)
    expect(result.truncated).toBe(false)
  })

  it('bounds line floods, discards overlong lines whole and retains the final useful error', () => {
    const stderr = new OpenCodeStderr()
    stderr.append(Buffer.from('private-input'.repeat(10000) + '\n' + 'short warning\n'.repeat(1000) + 'FINAL_CAUSE\n'))
    const result = stderr.snapshot()
    expect(result.text.length).toBeLessThanOrEqual(OPENCODE_STDERR_LIMITS.characters)
    expect(result.text).toContain('FINAL_CAUSE')
    expect(result.text).not.toContain('private-input')
    expect(result.droppedLines).toBeGreaterThan(900)
    expect(result.truncated).toBe(true)
    expect(result.text.split('\n').length).toBeLessThanOrEqual(OPENCODE_STDERR_LIMITS.lines)
  })

  it('does not leak a configured secret prefix or end a live decoder when snapshotting a partial line', () => {
    const stderr = new OpenCodeStderr(['opaque-runtime-password'])
    stderr.append(Buffer.from('failure: opaque-runtime-pass'))
    expect(stderr.snapshot().text).toBe('failure: [REDACTED]')
    stderr.append(Buffer.from('word\nnext error\n'))
    expect(stderr.snapshot().text).toBe('failure: [REDACTED]\nnext error')
  })

  it('strips terminal control sequences, credentials in URLs and preserves empty/unknown semantics', () => {
    const stderr = new OpenCodeStderr()
    expect(stderr.snapshot()).toMatchObject({ status: 'no-stderr-observed', observedBytes: 0, text: '' })
    stderr.append(Buffer.from('\x1b[31mEACCES\x1b[0m https://user:pass@example.com/error?api_key=secret\r\n'))
    expect(stderr.snapshot().text).toBe('EACCES https://example.com/error')
  })
  it('applies the same line and character limits to an incomplete final line without changing the live buffer', () => {
    const stderr = new OpenCodeStderr(['opaque-secret'])
    stderr.append(Buffer.from('warning\n'.repeat(64) + 'LAST_CAUSE opaque-secret'))
    const snapshot = stderr.snapshot()
    expect(snapshot.text.split('\n')).toHaveLength(64)
    expect(snapshot.text).toContain('LAST_CAUSE [REDACTED]')
    expect(snapshot.droppedLines).toBe(1)
    expect(stderr.snapshot()).toEqual(snapshot)
    stderr.append(Buffer.from('\n'))
    expect(stderr.snapshot().text).toBe(snapshot.text)
    const expanded = new OpenCodeStderr(['s'])
    expanded.append(Buffer.from('s'.repeat(4000)))
    expect(expanded.snapshot().text.length).toBeLessThanOrEqual(OPENCODE_STDERR_LIMITS.characters)
    expect(expanded.snapshot().truncated).toBe(true)
  })

  it('collects configured Provider/MCP/custom-header secrets without treating task text as credentials', () => {
    const secrets = collectRuntimeSecrets({
      instructions: ['a normal task'],
      provider: { selected: { options: { apiKey: 'opaque-api-key', headers: { 'X-Custom': 'opaque-extra' } } } },
      mcp: { server: { headers: { Authorization: 'Bearer opaque-mcp-key' } } }
    })
    expect(secrets).toEqual(expect.arrayContaining(['opaque-api-key', 'opaque-extra', 'opaque-mcp-key']))
    expect(secrets).not.toContain('a normal task')
    const stderr = new OpenCodeStderr(secrets)
    stderr.append(Buffer.from('opaque-api-key opaque-extra opaque-mcp-key\n'))
    expect(stderr.snapshot().text).toBe('[REDACTED] [REDACTED] [REDACTED]')
  })
})
