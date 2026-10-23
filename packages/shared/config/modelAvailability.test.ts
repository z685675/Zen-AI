import { describe, expect, it } from 'vitest'

import { parseAvailableModels } from './modelAvailability'

describe('authoritative model list protocol', () => {
  it('accepts a successful complete empty list', () => {
    expect(parseAvailableModels({ success: true, object: 'list', data: [] })).toEqual([])
  })
  it.each([
    undefined,
    '<html>error</html>',
    { success: false, object: 'list', data: [] },
    { success: true, data: [] },
    { success: true, object: 'list', data: null },
    { success: true, object: 'list', data: [{ id: '' }] },
    { success: true, object: 'list', data: [{ id: 'a' }, { id: 'a' }] }
  ])('rejects malformed/failed responses: %j', (value) => {
    expect(() => parseAvailableModels(value)).toThrow('invalid_model_availability')
  })
})
