import { describe, expect, it } from 'vitest'

import { haveSameAccessiblePaths } from '../sessionWorkspace'

describe('SessionService workspace inheritance', () => {
  it('recognizes an unchanged inherited workspace order', () => {
    expect(
      haveSameAccessiblePaths(['C:\\workspace-a', 'C:\\workspace-b'], ['C:\\workspace-a', 'C:\\workspace-b'])
    ).toBe(true)
  })

  it('preserves a session-specific current workspace order', () => {
    expect(
      haveSameAccessiblePaths(['C:\\workspace-b', 'C:\\workspace-a'], ['C:\\workspace-a', 'C:\\workspace-b'])
    ).toBe(false)
  })

  it('does not treat missing or partial path lists as inherited', () => {
    expect(haveSameAccessiblePaths(undefined, ['C:\\workspace-a'])).toBe(false)
    expect(haveSameAccessiblePaths(['C:\\workspace-a'], ['C:\\workspace-a', 'C:\\workspace-b'])).toBe(false)
  })
})
