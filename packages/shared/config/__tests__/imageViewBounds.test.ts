import { describe, expect, it } from 'vitest'

import { imageViewBounds } from '../imageCanvas'

describe('image workbench native view bounds', () => {
  it('rounds a valid content rectangle without changing the reserved title bar', () => {
    expect(imageViewBounds({ x: 140.2, y: 90.6, width: 900.3, height: 600.1 })).toEqual({
      x: 140,
      y: 91,
      width: 900,
      height: 600
    })
  })
  it('rejects invalid native view rectangles', () => {
    for (const bounds of [
      { x: 0, y: 0, width: NaN, height: 300 },
      { x: -1, y: 0, width: 300, height: 300 },
      { x: 0, y: 0, width: 300, height: 0 },
      { x: 0, y: 0, width: 300, height: 20001 }
    ])
      expect(() => imageViewBounds(bounds)).toThrow()
  })
})
