import { createHash } from 'node:crypto'

import { redactDiagnosticText, sanitizeDiagnostic } from '@shared/diagnostics'
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
      // The archive is already byte-bounded. Preserve the renderer's long-task
      // ledgers while still redacting credentials at this trust boundary.
      content = JSON.stringify(sanitizeDiagnostic(JSON.parse(file.content), 0, new WeakSet(), 4096), null, 2)
    } else {
      content = redactDiagnosticText(file.content)
    }
    const data = Buffer.from(content, 'utf8')
    if (data.length > 8 * 1024 * 1024) throw new Error('Diagnostic entry too large')
    total += data.length
    if (total > 20 * 1024 * 1024) throw new Error('Diagnostic package too large')
    zip.addFile(file.path, data)
    entries.push({ path: file.path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
  }
  zip.addFile(
    'integrity.json',
    Buffer.from(JSON.stringify({ algorithm: 'sha256', entries, totalBytes: total }, null, 2))
  )
  // Names are written as UTF-8 bytes. Mark both ZIP headers accordingly so
  // readers using the standard CP437 fallback do not mangle Chinese filenames.
  for (const entry of zip.getEntries()) entry.header.flags |= 0x800
  return zip.toBuffer()
}
