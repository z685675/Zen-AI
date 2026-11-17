import { describe, expect, it } from 'vitest'

import { isManagedModelRequest } from '../modelTransport'

describe('managed model transport scope', () => {
  it.each([
    '/v1/chat/completions',
    '/v1/responses',
    '/v1/responses/compact',
    '/v1/messages',
    '/v1/messages/count_tokens',
    '/v1/models',
    '/v1beta/models/gemini-test:streamGenerateContent',
    '/api/status'
  ])('accepts managed endpoint %s', (route) => {
    expect(isManagedModelRequest(`https://zenai.925636.xyz${route}`, 'POST')).toBe(true)
  })
  it.each([
    'https://zenai.925636.xyz.evil.example/v1/chat/completions',
    'https://zenai.925636.xyz:3000/v1/chat/completions',
    'https://user:password@zenai.925636.xyz/v1/chat/completions',
    'http://zenai.925636.xyz/v1/chat/completions',
    'https://zenai.925636.xyz/api/image-studio/tasks',
    'https://www.sciencedirect.com/v1/chat/completions',
    'not-a-url'
  ])('does not grant an arbitrary network bridge for %s', (url) => {
    expect(isManagedModelRequest(url, 'POST')).toBe(false)
  })
})
