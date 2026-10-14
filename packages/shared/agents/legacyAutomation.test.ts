import { describe, expect, it } from 'vitest'

import {
  assertLegacyAutomationEnabled,
  isLegacyAutomationEnabled,
  LEGACY_AUTOMATION_DISABLED_CODE
} from './legacyAutomation'

describe('legacy automation product boundary', () => {
  it('is closed without provider, developer-mode or runtime exceptions', () => {
    expect(isLegacyAutomationEnabled()).toBe(false)
    expect(assertLegacyAutomationEnabled).toThrow(expect.objectContaining({ code: LEGACY_AUTOMATION_DISABLED_CODE }))
  })
})
