import type { Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ApiService', () => ({
  checkModel: vi.fn()
}))

import { checkModel } from '../ApiService'
import { checkModelWithAnyKey } from '../HealthCheckService'

const mockedCheckModel = vi.mocked(checkModel)

const provider = {
  id: 'zen-api',
  name: 'Zen API',
  type: 'new-api',
  apiKey: 'key-a,key-b',
  apiHost: 'https://api.example.com',
  enabled: true
} as Provider

const model = {
  id: 'gpt-5.6-terra',
  name: 'GPT-5.6 Terra',
  provider: provider.id
} as Model

describe('checkModelWithAnyKey', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stops at the first working key and forwards the routing headers', async () => {
    mockedCheckModel.mockRejectedValueOnce(new Error('key-a failed')).mockResolvedValueOnce({ latency: 42 })

    const headers = { 'X-Zen-Context-Compaction': 'default-only' }
    await expect(checkModelWithAnyKey(provider, model, ['key-a', 'key-b'], 15_000, headers)).resolves.toEqual({
      key: 'key-b',
      latency: 42
    })

    expect(mockedCheckModel).toHaveBeenCalledTimes(2)
    expect(mockedCheckModel).toHaveBeenNthCalledWith(1, { ...provider, apiKey: 'key-a' }, model, 15_000, headers)
    expect(mockedCheckModel).toHaveBeenNthCalledWith(2, { ...provider, apiKey: 'key-b' }, model, 15_000, headers)
  })

  it('fails only after every configured key fails', async () => {
    const finalError = new Error('key-b failed')
    mockedCheckModel.mockRejectedValueOnce(new Error('key-a failed')).mockRejectedValueOnce(finalError)

    await expect(checkModelWithAnyKey(provider, model, ['key-a', 'key-b'])).rejects.toBe(finalError)
    expect(mockedCheckModel).toHaveBeenCalledTimes(2)
  })

  it('requests a complete text-generation check for checkpoint recovery probes', async () => {
    mockedCheckModel.mockResolvedValue({ latency: 18 })

    await expect(
      checkModelWithAnyKey(
        provider,
        model,
        ['key-a'],
        15_000,
        {
          'X-Zen-Context-Compaction': 'default-only'
        },
        true
      )
    ).resolves.toMatchObject({ key: 'key-a', latency: 18 })

    expect(mockedCheckModel).toHaveBeenCalledWith(
      { ...provider, apiKey: 'key-a' },
      model,
      15_000,
      { 'X-Zen-Context-Compaction': 'default-only' },
      true
    )
  })
})
