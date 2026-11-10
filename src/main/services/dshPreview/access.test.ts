import { afterEach, describe, expect, it } from 'vitest'

import { assertDshPreviewUnlocked, isDshPreviewUnlocked, lockDshPreview, unlockDshPreview } from './access'

afterEach(lockDshPreview)

describe('internal testing access', () => {
  it('rejects direct execution and invalid passwords before unlocking', () => {
    expect(isDshPreviewUnlocked()).toBe(false)
    expect(() => assertDshPreviewUnlocked()).toThrow('Internal testing is locked')
    for (const password of [undefined, true, { unlocked: true }, '', 'wrong', 'x'.repeat(129)]) {
      expect(unlockDshPreview(password)).toBe(false)
      expect(isDshPreviewUnlocked()).toBe(false)
    }
  })

  it('opens with the exact password and revokes access on lock', () => {
    expect(unlockDshPreview('\u4e16\u754c\u548c\u5e73')).toBe(true)
    expect(() => assertDshPreviewUnlocked()).not.toThrow()
    lockDshPreview()
    expect(() => assertDshPreviewUnlocked()).toThrow('Internal testing is locked')
  })
})
