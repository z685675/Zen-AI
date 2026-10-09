import { createHash } from 'node:crypto'

import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'

import { buildDiagnosticArchive } from '../diagnosticArchive'

describe('diagnostic ZIP integrity', () => {
  it('exports readable files, redacts at the main boundary and checksums every entry', () => {
    const zip = new AdmZip(
      buildDiagnosticArchive([
        {
          path: 'error.json',
          content: JSON.stringify({ apiKey: 'fake-secret', input_tokens: 400, cause: '{"apiKey":"nested-secret"}' })
        },
        { path: '链路结论.txt', content: 'API_KEY=stderr-secret' }
      ])
    )
    const manifest = JSON.parse(zip.readAsText('integrity.json'))
    for (const entry of manifest.entries) {
      const buffer = zip.getEntry(entry.path)!.getData()
      expect(createHash('sha256').update(buffer).digest('hex')).toBe(entry.sha256)
      expect(buffer.length).toBe(entry.bytes)
    }
    expect(zip.readAsText('error.json')).toContain('400')
    for (const entry of zip.getEntries())
      expect(entry.getData().toString()).not.toMatch(/fake-secret|nested-secret|stderr-secret/)
  })
  it('rejects traversal, duplicate names and malformed JSON rather than silently skipping entries', () => {
    for (const path of ['../secret.txt', 'C:\\secret.txt', '/secret.txt', 'integrity.json'])
      expect(() => buildDiagnosticArchive([{ path, content: '{}' }])).toThrow()
    expect(() =>
      buildDiagnosticArchive([
        { path: 'a.json', content: '{}' },
        { path: 'a.json', content: '{}' }
      ])
    ).toThrow()
    expect(() => buildDiagnosticArchive([{ path: 'a.json', content: '{invalid' }])).toThrow()
  })
})
