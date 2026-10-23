import type { TextStreamPart } from 'ai'

import { isAbortError } from './error'

type AgentPart = TextStreamPart<Record<string, any>>

/** Parse SSE without treating EOF/[DONE] as an AI SDK finish signal. */
export const createSSEReadableStream = (source: ReadableStream<Uint8Array>, signal: AbortSignal) => {
  const reader = source.getReader()
  let stopped = false
  let removeAbortListener = () => {}
  const cancelReader = (reason?: unknown) => reader.cancel(reason).catch(() => {})

  return new ReadableStream<AgentPart>({
    start(controller) {
      const decoder = new TextDecoder()
      let buffer = ''
      const abortHandler = () => {
        if (stopped) return
        stopped = true
        void cancelReader(signal.reason)
        controller.error(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
      }
      removeAbortListener = () => signal.removeEventListener('abort', abortHandler)
      if (signal.aborted) abortHandler()
      else signal.addEventListener('abort', abortHandler, { once: true })

      const emitEvent = (event: string) => {
        const payload = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (!payload) return
        if (payload === '[DONE]') {
          stopped = true
          controller.close()
          void cancelReader()
          return
        }
        let part: AgentPart
        try {
          part = JSON.parse(payload)
          if (!part || typeof part.type !== 'string') throw new Error('Missing stream part type')
        } catch {
          // Do not log raw data: malformed events can contain credentials or user content.
          throw new Error('Invalid agent SSE event')
        }
        controller.enqueue(part)
        if (part.type === 'error' || part.type === 'abort') {
          // The first terminal failure wins, even if the socket subsequently
          // rejects or the server sends a stale finish/[DONE].
          stopped = true
          controller.close()
          void cancelReader()
        }
      }

      const pump = async () => {
        try {
          while (!stopped) {
            const { value, done } = await reader.read()
            if (stopped) return
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
            let separator = /\r?\n\r?\n/.exec(buffer)
            while (separator && !stopped) {
              const event = buffer.slice(0, separator.index)
              buffer = buffer.slice(separator.index + separator[0].length)
              emitEvent(event)
              separator = /\r?\n\r?\n/.exec(buffer)
            }
            if (done && !stopped) {
              if (buffer.trim()) emitEvent(buffer)
              if (!stopped) {
                stopped = true
                controller.close()
              }
            }
          }
        } catch (error) {
          if (!stopped) {
            stopped = true
            controller.error(error)
            void cancelReader(error)
          }
        } finally {
          removeAbortListener()
          reader.releaseLock()
        }
      }
      void pump()
    },
    cancel(reason) {
      stopped = true
      removeAbortListener()
      return cancelReader(reason)
    }
  })
}

/** Only an actual abort rejection is cancellation, not an unrelated socket failure. */
export const withAbortStreamPart = (source: ReadableStream<AgentPart>, signal: AbortSignal) => {
  const reader = source.getReader()
  return new ReadableStream<AgentPart>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          reader.releaseLock()
          controller.close()
        } else controller.enqueue(value)
      } catch (error) {
        reader.releaseLock()
        if (signal.aborted && isAbortError(error)) {
          controller.enqueue({ type: 'abort' })
          controller.close()
        } else controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        reader.releaseLock()
      }
    }
  })
}
