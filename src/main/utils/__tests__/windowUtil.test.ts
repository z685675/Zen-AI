import { describe, expect, it } from 'vitest'

import { resolveWindowsBackgroundMaterial } from '../windowUtil'

describe('getWindowsBackgroundMaterial', () => {
  it('returns true on Windows 11 22H2 and newer', () => {
    expect(resolveWindowsBackgroundMaterial(true, '10.0.22621')).toBe(true)
  })

  it('returns false below the Windows 11 22H2 build threshold', () => {
    expect(resolveWindowsBackgroundMaterial(true, '10.0.22000')).toBe(false)
  })

  it('returns false when the system version cannot be parsed', () => {
    expect(resolveWindowsBackgroundMaterial(true, 'Windows 11')).toBe(false)
  })

  it('returns false on non-Windows platforms', () => {
    expect(resolveWindowsBackgroundMaterial(false, '10.0.22621')).toBe(false)
  })
})
