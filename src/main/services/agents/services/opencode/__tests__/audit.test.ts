import { describe, expect, it } from 'vitest'

import { buildOpenCodeAuditHeaders } from '../audit'

describe('OpenCode audit identity', () => {
  it('uses the existing installation identity for managed Providers', () => {
    expect(buildOpenCodeAuditHeaders('https://zenai.925636.xyz/v1', 'install-a', '1.1.71', 'darwin-arm64')).toEqual({
      'X-Zen-Client-Id': 'install-a',
      'X-Zen-App-Version': '1.1.71',
      'X-Zen-Platform': 'darwin-arm64'
    })
  })
  it('does not disclose the installation identity to third parties or deceptive suffixes', () => {
    for (const host of [
      'https://other.example/v1',
      'https://zenai.925636.xyz.other.example/v1',
      'http://localhost:3000/v1'
    ])
      expect(buildOpenCodeAuditHeaders(host, 'install-a', '1.1.71', 'win32-x64')).not.toHaveProperty('X-Zen-Client-Id')
  })
})
