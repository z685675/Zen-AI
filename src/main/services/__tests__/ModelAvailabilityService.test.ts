import { getModelCapabilities } from '@shared/modelCapabilities'
import type { Provider } from '@types'
import { describe, expect, it, vi } from 'vitest'

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: fetcher } }))

import { getCachedModelAvailability, refreshModelAvailability } from '../ModelAvailabilityService'

const provider = (id: string, apiKey = 'fake-key'): Provider => ({
  id,
  apiKey,
  apiHost: 'https://zenai.925636.xyz/v1',
  enabled: true,
  models: [],
  type: 'new-api',
  name: id
})
const response = (models: string[]) =>
  new Response(JSON.stringify({ success: true, object: 'list', data: models.map((id) => ({ id })) }), {
    headers: { 'X-Zen-Models-Authoritative': '1' }
  })

describe('model availability transport (no paid requests)', () => {
  it('limits rotating-key capabilities to what every key can use', async () => {
    const p = provider('key-capabilities', 'first,second')
    for (const limit of [900_000, 64_000])
      fetcher.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            object: 'list',
            data: [{ id: 'new-alias', model_capabilities: { context_length: limit, tools: limit > 64_000 } }]
          }),
          { headers: { 'X-Zen-Models-Authoritative': '1' } }
        )
      )
    await refreshModelAvailability(p, true)
    expect(getModelCapabilities({ provider: p.id, id: 'new-alias' })).toMatchObject({
      context_length: 64_000,
      tools: false
    })
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await refreshModelAvailability(p, true)
    expect(getModelCapabilities({ provider: p.id, id: 'new-alias' })?.tools).toBe(false)
    fetcher.mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([]))
    await refreshModelAvailability(p, true)
    expect(getModelCapabilities({ provider: p.id, id: 'new-alias' })).toBeUndefined()
  })
  it('keeps the last success on network/auth/format errors, but accepts real empty supply', async () => {
    const p = provider('failure-retention')
    fetcher.mockResolvedValueOnce(response(['A']))
    const initial = await refreshModelAvailability(p, true)
    for (const failure of [
      new Response('{}', { status: 401 }),
      new Response('<html/>'),
      new Response(JSON.stringify({ success: false, object: 'list', data: [] }), {
        headers: { 'X-Zen-Models-Authoritative': '1' }
      })
    ]) {
      fetcher.mockResolvedValueOnce(failure)
      expect(await refreshModelAvailability(p, true)).toEqual(initial)
    }
    fetcher.mockRejectedValueOnce(new TypeError('offline'))
    expect(await refreshModelAvailability(p, true)).toEqual(initial)
    fetcher.mockResolvedValueOnce(response([]))
    expect((await refreshModelAvailability(p, true))?.models).toEqual([])
  })
  it('intersects rotating key permissions without sending model completions', async () => {
    const p = provider('key-scope', 'first,second')
    fetcher.mockResolvedValueOnce(response(['A', 'B'])).mockResolvedValueOnce(response(['B', 'C']))
    expect((await refreshModelAvailability(p, true))?.models.map((model) => model.id)).toEqual(['B'])
    const [url, options] = fetcher.mock.calls.at(-1)!
    expect(url).toBe('https://zenai.925636.xyz/api/client/models')
    expect(url).not.toContain('second')
    expect(options.body).toBeUndefined()
    expect(options.redirect).toBe('error')
  })
  it('coalesces identical refreshes and discards old credential responses', async () => {
    const old = provider('source-race', 'old')
    const next = provider('source-race', 'new')
    let finish!: (value: Response) => void
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        })
    )
    const pending = refreshModelAvailability(old, true)
    const same = refreshModelAvailability(old, true)
    fetcher.mockResolvedValueOnce(response(['B']))
    expect((await refreshModelAvailability(next, true))?.models[0].id).toBe('B')
    finish(response(['A']))
    expect(await pending).toBeUndefined()
    expect(await same).toBeUndefined()
    expect(getCachedModelAvailability(next)?.models[0].id).toBe('B')
  })
  it('does not send credentials to a third-party, insecure or invalid URL', async () => {
    const count = fetcher.mock.calls.length
    for (const apiHost of [
      'http://zenai.925636.xyz',
      'https://example.com',
      'https://user:pass@zenai.925636.xyz',
      'invalid'
    ]) {
      expect(await refreshModelAvailability({ ...provider('invalid'), apiHost }, true)).toBeUndefined()
    }
    expect(await refreshModelAvailability({} as Provider, true)).toBeUndefined()
    expect(fetcher.mock.calls.length).toBe(count)
  })
})
