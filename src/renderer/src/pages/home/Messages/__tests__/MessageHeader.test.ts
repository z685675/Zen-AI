import type { Model } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { getMessageHeaderModelName } from '../MessageHeader'

describe('getMessageHeaderModelName', () => {
  it('shows only the model name without its provider', () => {
    const model = {
      id: 'gemini-3-flash-preview',
      name: 'Gemini 3 Flash',
      provider: 'zen'
    } as Model

    expect(getMessageHeaderModelName(model)).toBe('Gemini 3 Flash')
  })

  it('falls back to the model id without adding provider information', () => {
    const model = {
      id: 'gpt-5.6-luna',
      provider: 'zen'
    } as Model

    expect(getMessageHeaderModelName(model)).toBe('gpt-5.6-luna')
    expect(getMessageHeaderModelName(undefined, 'grok-4.5')).toBe('grok-4.5')
  })
})
