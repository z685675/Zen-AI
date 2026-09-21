import type { Provider } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { getErrorStatusCode, orderChatApiKeys, shouldRotateChatApiKey } from '../chatKeyFailover'

const provider = (apiKey: string) => ({ id: 'newapi', apiKey }) as Provider

describe('chat API key failover', () => {
  it('rotates for authentication failures', () => {
    expect(shouldRotateChatApiKey({ statusCode: 401, message: 'invalid credentials' })).toBe(true)
    expect(shouldRotateChatApiKey({ statusCode: 403, message: 'API key is not allowed' })).toBe(true)
    expect(getErrorStatusCode({ response: { status: 401 } })).toBe(401)
  })

  it('does not rotate for generic service failures or generic 429 responses', () => {
    expect(shouldRotateChatApiKey({ statusCode: 500, message: 'service unavailable' })).toBe(false)
    expect(shouldRotateChatApiKey({ statusCode: 429, message: 'too many requests' })).toBe(false)
  })

  it('rotates for an explicitly key-scoped 429 response', () => {
    expect(shouldRotateChatApiKey({ statusCode: 429, message: 'API key rate limit exceeded' })).toBe(true)
    expect(shouldRotateChatApiKey({ statusCode: 429, message: 'insufficient_quota for token' })).toBe(true)
  })

  it('keeps the stable key first and tries remaining keys once', () => {
    expect(orderChatApiKeys(provider('key-a,key-b,key-c'), 'key-b')).toEqual(['key-b', 'key-c', 'key-a'])
    expect(orderChatApiKeys(provider('key-a,key-b'), 'unknown')).toEqual(['key-a', 'key-b'])
  })
})
