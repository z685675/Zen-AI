import { describe, expect, it } from 'vitest'

import { imageStudioBounds, imageStudioOrigin } from '../imageStudio'

describe('image workspace isolation', () => {
  it('allows HTTPS gateways and local development only', () => {
    expect(imageStudioOrigin('https://example.com/v1')).toBe('https://example.com')
    expect(imageStudioOrigin('http://127.0.0.1:3000/v1')).toBe('http://127.0.0.1:3000')
    for (const url of [
      'http://example.com',
      'file:///tmp/studio',
      'javascript:alert(1)',
      'https://key@example.com',
      'https://example.com/?key=secret'
    ])
      expect(() => imageStudioOrigin(url)).toThrow()
  })
  it('rejects invalid native view rectangles', () => {
    expect(() => imageStudioBounds({ x: 0, y: 0, width: NaN, height: 300 })).toThrow()
    expect(() => imageStudioBounds({ x: -1, y: 0, width: 300, height: 300 })).toThrow()
  })
})
