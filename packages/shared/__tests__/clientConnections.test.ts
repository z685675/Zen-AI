import { describe, expect, it } from 'vitest'

import { isPublicIPv4Origin, isRoutableApiRequest } from '../clientConnections'

describe('client connection trust boundaries', () => {
  it.each(['https://47.103.91.113', 'https://8.8.4.4'])('accepts public IP origin %s', (origin) =>
    expect(isPublicIPv4Origin(origin)).toBe(true)
  )
  it.each([
    'http://47.103.91.113',
    'https://47.103.91.113/path',
    'https://127.0.0.1',
    'https://10.0.0.1',
    'https://100.100.100.200',
    'https://192.168.0.1',
    'https://198.18.0.1',
    'https://[::1]',
    'https://example.com',
    'https://user@47.103.91.113'
  ])('rejects unsafe origin %s', (origin) => expect(isPublicIPv4Origin(origin)).toBe(false))
  it('includes reference upload, persisted jobs, existing assets and quota but excludes arbitrary URLs', () => {
    for (const path of [
      '/api/image-studio/bootstrap',
      '/api/image-studio/assets',
      '/api/image-studio/jobs',
      '/api/image-studio/jobs/by-submission/123-abc',
      '/api/usage/token/model-daily/turn/state'
    ])
      expect(isRoutableApiRequest('https://zenai.925636.xyz' + path, 'POST')).toBe(true)
    expect(isRoutableApiRequest('https://zenai.925636.xyz.evil.com/v1/models')).toBe(false)
    expect(isRoutableApiRequest('https://download.925636.xyz/v1/models')).toBe(false)
    expect(isRoutableApiRequest('https://zenai.925636.xyz/api/option/')).toBe(false)
  })
})
