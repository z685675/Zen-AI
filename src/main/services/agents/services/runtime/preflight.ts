import type { AgentStream } from '../../interfaces/AgentStreamInterface'

export function failAgentStreamBeforeStart<T extends AgentStream>(stream: T, error: Error): T {
  setImmediate(() => {
    stream.emit('data', { type: 'error', error })
  })

  return stream
}
