import type { AgentStream } from '../../interfaces/AgentStreamInterface'

export function failAgentStreamBeforeStart<T extends AgentStream>(stream: T, error: Error): T {
  Object.assign(error, { zenFailureStage: 'runtime-startup' })
  setImmediate(() => {
    stream.emit('data', { type: 'error', error })
  })

  return stream
}
