import { describe, expect, it } from 'vitest'

import { isCodexRuntimeEnabled } from '../features'

describe('isCodexRuntimeEnabled', () => {
  it('supports explicit enable values', () => {
    expect(isCodexRuntimeEnabled({ ZEN_ENABLE_CODEX_RUNTIME: 'true' })).toBe(true)
    expect(isCodexRuntimeEnabled({ ZEN_ENABLE_CODEX_RUNTIME: '1' })).toBe(true)
  })

  it('supports explicit disable values', () => {
    expect(isCodexRuntimeEnabled({ ZEN_ENABLE_CODEX_RUNTIME: 'false' })).toBe(false)
    expect(isCodexRuntimeEnabled({ ZEN_ENABLE_CODEX_RUNTIME: '0' })).toBe(false)
  })
})
