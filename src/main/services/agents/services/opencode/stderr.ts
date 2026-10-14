import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'

import { diagnosticText, sanitizeDiagnostic } from '../../../../../../packages/shared/diagnostics'

export const OPENCODE_STDERR_LIMITS = { characters: 8000, lines: 64, lineCharacters: 4096 } as const

/** Collect known configured secrets without retaining or exporting the configuration itself. */
export function collectRuntimeSecrets(value: unknown, depth = 0): string[] {
  if (!value || typeof value !== 'object' || depth > 10) return []
  return Object.entries(value)
    .slice(0, 256)
    .flatMap(([key, item]) => {
      if (typeof item === 'string') {
        const sanitized = sanitizeDiagnostic({ [key]: item }) as Record<string, unknown>
        return sanitized[key] === '[REDACTED]' ? [item, item.replace(/^Bearer\s+/i, '')] : []
      }
      // Headers can contain opaque custom credentials, not just Authorization.
      if (key === 'headers' && item && typeof item === 'object')
        return Object.values(item).flatMap((header) =>
          typeof header === 'string' ? [header, header.replace(/^Bearer\s+/i, '')] : []
        )
      return collectRuntimeSecrets(item, depth + 1)
    })
}

/** Redact complete lines so credentials split across pipe chunks cannot leak. No per-chunk events. */
export class OpenCodeStderr {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private discarding = false
  private lines: string[] = []
  private characters = 0
  private bytes = 0
  private droppedLines = 0
  private secrets: string[]

  constructor(secrets: string[] = []) {
    this.secrets = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)
  }

  append(chunk: Buffer) {
    this.bytes += chunk.length
    for (let offset = 0; offset < chunk.length; offset += 4096)
      this.appendText(this.decoder.write(chunk.subarray(offset, offset + 4096)))
  }

  private appendText(text: string) {
    const parts = text.split(/\r?\n/)
    for (let index = 0; index < parts.length; index++) {
      if (!this.discarding) {
        if (this.pending.length + parts[index].length > OPENCODE_STDERR_LIMITS.lineCharacters) {
          this.pending = ''
          this.discarding = true
          this.droppedLines++
        } else this.pending += parts[index]
      }
      if (index < parts.length - 1) {
        if (!this.discarding && this.pending) this.keep(this.redact(this.pending))
        this.pending = ''
        this.discarding = false
      }
    }
  }

  private redact(line: string) {
    let text = stripVTControlCharacters(line)
    for (const secret of this.secrets) text = text.replaceAll(secret, '[REDACTED]')
    // A snapshot can occur between chunks. Suppress a known secret's partial suffix too.
    for (const secret of this.secrets) {
      for (let length = Math.min(secret.length - 1, text.length); length >= 4; length--) {
        if (text.endsWith(secret.slice(0, length))) {
          text = text.slice(0, -length) + '[REDACTED]'
          break
        }
      }
    }
    return diagnosticText(text)
  }

  private keep(line: string) {
    this.lines.push(line)
    this.characters += line.length + 1
    while (this.lines.length > OPENCODE_STDERR_LIMITS.lines || this.characters > OPENCODE_STDERR_LIMITS.characters) {
      this.characters -= this.lines.shift()!.length + 1
      this.droppedLines++
    }
  }

  snapshot() {
    const pending = !this.discarding && this.pending ? this.redact(this.pending) : ''
    // Snapshotting a turn must not end the decoder for a still-running process.
    const lines = [...this.lines, ...(pending ? [pending] : [])]
    let characters = lines.reduce((sum, line) => sum + line.length + 1, 0)
    let droppedLines = this.droppedLines
    while (lines.length > OPENCODE_STDERR_LIMITS.lines || characters > OPENCODE_STDERR_LIMITS.characters) {
      characters -= lines.shift()!.length + 1
      droppedLines++
    }
    const text = lines.join('\n')
    return {
      text: diagnosticText(text),
      observedBytes: this.bytes,
      droppedLines,
      truncated: droppedLines > 0,
      pendingLine: Boolean(pending),
      limits: OPENCODE_STDERR_LIMITS,
      scope: 'current-operation-observation-window',
      status: this.bytes ? 'collected-bounded-redacted-stderr' : 'no-stderr-observed'
    }
  }
}
