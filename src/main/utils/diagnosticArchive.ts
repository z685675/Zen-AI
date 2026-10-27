import { createHash } from 'node:crypto'

import { diagnosticText, sanitizeDiagnostic } from '@shared/diagnostics'
import AdmZip from 'adm-zip'

export function buildDiagnosticArchive(files: Array<{ path: string; content: string }>): Buffer {
  if (!Array.isArray(files) || files.length > 64) throw new Error('Invalid diagnostic package files')
  const zip = new AdmZip()
  const entries: Array<{ path: string; bytes: number; sha256: string }> = []
  let total = 0
  for (const file of files) {
    if (
      typeof file.path !== 'string' ||
      typeof file.content !== 'string' ||
      !/^[\p{L}\w.-]+\.(?:json|txt|md)$/u.test(file.path) ||
      file.path === 'integrity.json' ||
      entries.some((entry) => entry.path === file.path)
    )
      throw new Error('Invalid diagnostic package entry')
    if (Buffer.byteLength(file.content, 'utf8') > 8 * 1024 * 1024) throw new Error('Diagnostic entry too large')
    let content: string
    if (file.path.endsWith('.json')) {
      content = JSON.stringify(sanitizeDiagnostic(JSON.parse(file.content)), null, 2)
    } else {
      content = diagnosticText(file.content)
    }
    const data = Buffer.from(content, 'utf8')
    total += data.length
    if (total > 20 * 1024 * 1024) throw new Error('Diagnostic package too large')
    zip.addFile(file.path, data)
    entries.push({ path: file.path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
  }
  zip.addFile(
    'integrity.json',
    Buffer.from(JSON.stringify({ algorithm: 'sha256', entries, totalBytes: total }, null, 2))
  )
  return zip.toBuffer()
}
