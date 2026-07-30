import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import type { AgentStream, AgentStreamEvent } from '../../../interfaces/AgentStreamInterface'
import { failAgentStreamBeforeStart } from '../preflight'

class TestAgentStream extends EventEmitter implements AgentStream {
  declare emit: (event: 'data', data: AgentStreamEvent) => boolean
  declare on: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
  declare once: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
}

describe('failAgentStreamBeforeStart', () => {
  it('defers the error until callers can attach a listener', async () => {
    const stream = new TestAgentStream()
    const expectedError = new Error('preflight failed')

    failAgentStreamBeforeStart(stream, expectedError)

    const event = await new Promise<AgentStreamEvent>((resolve) => {
      stream.once('data', resolve)
    })

    expect(event).toEqual({ type: 'error', error: expectedError })
  })
})
