import { createHash } from 'node:crypto'

import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'

import { buildDiagnosticArchive } from '../diagnosticArchive'

describe('diagnostic ZIP integrity', () => {
  it('marks UTF-8 filenames in both central and local headers for independent ZIP readers', () => {
    const data = buildDiagnosticArchive([{ path: '本轮耗时报告.md', content: '# 报告' }])
    const zip = new AdmZip(data)
    for (const entry of zip.getEntries()) {
      expect(entry.header.flags & 0x800).toBe(0x800)
      const offset = entry.header.offset
      expect(data.readUInt32LE(offset)).toBe(0x04034b50)
      expect(data.readUInt16LE(offset + 6) & 0x800).toBe(0x800)
      const length = data.readUInt16LE(offset + 26)
      expect(data.subarray(offset + 30, offset + 30 + length).toString('utf8')).toBe(entry.entryName)
    }
    expect(zip.readAsText('本轮耗时报告.md')).toBe('# 报告')
  })
  it('exports readable files, redacts at the main boundary and checksums every entry', () => {
    const zip = new AdmZip(
      buildDiagnosticArchive([
        {
          path: 'error.json',
          content: JSON.stringify({ apiKey: 'fake-secret', input_tokens: 400, cause: '{"apiKey":"nested-secret"}' })
        },
        { path: '链路结论.txt', content: 'API_KEY=stderr-secret' },
        { path: '本轮耗时报告.md', content: '# 本轮耗时\n\nAPI_KEY=report-secret\n首字用时：2秒' }
      ])
    )
    const manifest = JSON.parse(zip.readAsText('integrity.json'))
    for (const entry of manifest.entries) {
      const buffer = zip.getEntry(entry.path)!.getData()
      expect(createHash('sha256').update(buffer).digest('hex')).toBe(entry.sha256)
      expect(buffer.length).toBe(entry.bytes)
    }
    expect(zip.readAsText('error.json')).toContain('400')
    expect(zip.readAsText('本轮耗时报告.md')).toContain('首字用时：2秒')
    for (const entry of zip.getEntries())
      expect(entry.getData().toString()).not.toMatch(/fake-secret|nested-secret|stderr-secret|report-secret/)
  })
  it('rejects traversal, duplicate names and malformed JSON rather than silently skipping entries', () => {
    for (const path of [
      '../secret.txt',
      '../report.md',
      'C:\\secret.txt',
      '/secret.txt',
      'integrity.json',
      'run.js',
      'view.html'
    ])
      expect(() => buildDiagnosticArchive([{ path, content: '{}' }])).toThrow()
    expect(() =>
      buildDiagnosticArchive([
        { path: 'a.json', content: '{}' },
        { path: 'a.json', content: '{}' }
      ])
    ).toThrow()
    expect(() => buildDiagnosticArchive([{ path: 'a.json', content: '{invalid' }])).toThrow()
  })

  it('preserves long-task records in the actual ZIP while redacting the full report', () => {
    const events = Array.from({ length: 700 }, (_, index) => ({ index, apiKey: `secret-${index}` }))
    const report = events
      .map(({ index }) => `调用 ${index}：参数一致；Authorization: Bearer secret-${index}`)
      .join('\n')
    expect(report.length).toBeGreaterThan(8_000)
    const zip = new AdmZip(
      buildDiagnosticArchive([
        { path: 'timeline.json', content: JSON.stringify({ events, main: { events } }) },
        { path: '工具参数对账.txt', content: report }
      ])
    )
    const timeline = JSON.parse(zip.readAsText('timeline.json'))
    expect(timeline.events).toHaveLength(700)
    expect(timeline.main.events).toHaveLength(700)
    expect(timeline.events[350]).toEqual({ index: 350, apiKey: '[REDACTED]' })
    const text = zip.readAsText('工具参数对账.txt')
    for (const index of [0, 350, 699]) expect(text).toContain(`调用 ${index}：`)
    expect(text).not.toMatch(/secret-\d|truncated/)
    const manifest = JSON.parse(zip.readAsText('integrity.json'))
    for (const entry of manifest.entries) {
      const data = zip.getEntry(entry.path)!.getData()
      expect(entry.bytes).toBe(data.length)
      expect(entry.sha256).toBe(createHash('sha256').update(data).digest('hex'))
    }
  })

  it('retains byte limits even when redaction expands an entry', () => {
    expect(() => buildDiagnosticArchive([{ path: 'large.txt', content: 'x'.repeat(8 * 1024 * 1024 + 1) }])).toThrow(
      /entry too large/
    )
    const expanding = 'token=x\n'.repeat(600_000)
    expect(Buffer.byteLength(expanding)).toBeLessThan(8 * 1024 * 1024)
    expect(() => buildDiagnosticArchive([{ path: 'large.txt', content: expanding }])).toThrow(/entry too large/)
  })
})
