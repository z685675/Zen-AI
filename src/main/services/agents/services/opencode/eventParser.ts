import type { OpenCodeEvent } from './client'

// A 20 MiB native media read becomes ~27 MiB of Base64. This is a per-event
// transport budget, NOT a file-upload or conversation-size limit. Leave room
// for multiple normalized images while keeping a damaged local stream bounded.
export const OPENCODE_EVENT_MAX_BYTES = 64 * 1024 * 1024
const BLOCK_BYTES = 64 * 1024

function eventError(message: string, details?: Record<string, number>) {
  return Object.assign(new Error(message), {
    zenFailureStage: 'agent-runtime',
    zenRuntimeId: 'opencode',
    zenEventStream: details
  })
}

/** Incremental SSE framing. Each byte is scanned/copied once, rather than
 * repeatedly rescanning a growing Base64 string on every network chunk. */
export class OpenCodeEventParser {
  private blocks: Buffer[] = []
  private tail?: Buffer
  private tailLength = 0
  private bytes = 0
  private lineLength = 0
  private skipLF = false
  private firstFrame = true

  constructor(private readonly maxBytes = OPENCODE_EVENT_MAX_BYTES) {}

  *push(chunk: Uint8Array): Generator<OpenCodeEvent> {
    let start = 0
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index]
      if (this.skipLF) {
        this.skipLF = false
        if (byte === 10) {
          start = index + 1
          continue
        }
      }
      if (byte !== 10 && byte !== 13) continue
      this.append(chunk.subarray(start, index))
      const emptyLine = this.lineLength === 0
      this.append(new Uint8Array([10]))
      this.lineLength = 0
      this.skipLF = byte === 13
      start = index + 1
      if (emptyLine) {
        const event = this.finishFrame()
        if (event) yield event
      }
    }
    this.append(chunk.subarray(start))
  }

  private append(chunk: Uint8Array) {
    if (!chunk.length) return
    this.bytes += chunk.length
    if (this.bytes > this.maxBytes) {
      throw eventError('OpenCode event frame exceeded the transport byte budget', {
        receivedBytes: this.bytes,
        maxBytes: this.maxBytes
      })
    }
    this.lineLength += chunk.length
    let offset = 0
    while (offset < chunk.length) {
      this.tail ??= Buffer.allocUnsafe(Math.min(BLOCK_BYTES, this.maxBytes))
      const size = Math.min(this.tail.length - this.tailLength, chunk.length - offset)
      this.tail.set(chunk.subarray(offset, offset + size), this.tailLength)
      this.tailLength += size
      offset += size
      if (this.tailLength === this.tail.length) {
        this.blocks.push(this.tail)
        this.tail = undefined
        this.tailLength = 0
      }
    }
  }

  private finishFrame(): OpenCodeEvent | undefined {
    if (this.tailLength) this.blocks.push(this.tail!.subarray(0, this.tailLength))
    let frame = Buffer.concat(this.blocks, this.bytes).toString('utf8')
    if (this.firstFrame) {
      this.firstFrame = false
      if (frame.startsWith('\uFEFF')) frame = frame.slice(1)
    }
    this.blocks = []
    this.tail = undefined
    this.tailLength = 0
    this.bytes = 0
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => (line[5] === ' ' ? line.slice(6) : line.slice(5)))
      .join('\n')
    if (!data || data === '[DONE]') return
    try {
      const event = JSON.parse(data)
      if (
        !event ||
        typeof event.type !== 'string' ||
        !event.properties ||
        typeof event.properties !== 'object' ||
        Array.isArray(event.properties)
      )
        throw new Error('Invalid event shape')
      return event as OpenCodeEvent
    } catch {
      // JSON parser messages may contain private attachment text. Never echo it.
      throw eventError('OpenCode event stream returned an invalid event')
    }
  }
}
