import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ connect: vi.fn(), call: vi.fn(), close: vi.fn(), transports: [] as any[] }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mocks.connect
    callTool = mocks.call
    close = mocks.close
  }
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options: any) {
      mocks.transports.push({ url, options })
    }
  }
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.transports.length = 0
  mocks.connect.mockResolvedValue(undefined)
  mocks.close.mockResolvedValue(undefined)
  mocks.call.mockResolvedValue({
    content: [
      {
        type: 'text',
        text: 'Title: Policy\nURL: https://example.org/policy\nPublished: 2026-10-01\nHighlights: Current rules'
      }
    ]
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('lazy public search', () => {
  it('module discovery does not connect, and sends only the explicit query/count on demand', async () => {
    const { searchAssistantWeb } = await import('../assistantWebSearch')
    expect(mocks.connect).not.toHaveBeenCalled()
    const result = await searchAssistantWeb('public policy', 3)
    expect(mocks.call).toHaveBeenCalledWith(
      { name: 'web_search_exa', arguments: { query: 'public policy', numResults: 3 } },
      undefined,
      expect.objectContaining({ timeout: 20_000 })
    )
    expect(result.sources).toEqual([
      expect.objectContaining({ title: 'Policy', url: 'https://example.org/policy', published: '2026-10-01' })
    ])
    expect(mocks.transports[0].url.href).toBe('https://mcp.exa.ai/mcp?tools=web_search_exa')
    expect(mocks.transports[0].options.authProvider).toBeUndefined()
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it('leaves missing dates unknown and excludes unsafe URL schemes', async () => {
    const { parseSearchSources } = await import('../assistantWebSearch')
    expect(
      parseSearchSources('Title: Good\nURL: https://example.org\nText: content\nTitle: Bad\nURL: javascript:alert(1)')
    ).toEqual([expect.objectContaining({ title: 'Good', published: null })])
    expect(parseSearchSources('Title: Private\nURL: https://key:secret@example.org')).toEqual([])
  })
  it('validates input before making any request', async () => {
    const { searchAssistantWeb } = await import('../assistantWebSearch')
    for (const [query, count] of [
      ['', 1],
      ['q'.repeat(1501), 1],
      ['q', 9],
      ['q', 1.5]
    ])
      await expect(searchAssistantWeb(query, count)).rejects.toThrow()
    expect(mocks.connect).not.toHaveBeenCalled()
  })
  it('returns explicit service failure for tool errors, not a fabricated empty successful search', async () => {
    const { searchAssistantWeb } = await import('../assistantWebSearch')
    mocks.call.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'secret remote error' }] })
    await expect(searchAssistantWeb('q', 1)).rejects.toThrow('Web search unavailable')
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it('caps unstructured extracts and labels the parsing limitation', async () => {
    const { searchAssistantWeb } = await import('../assistantWebSearch')
    mocks.call.mockResolvedValue({ content: [{ type: 'text', text: 'x'.repeat(50_000) }] })
    const result = await searchAssistantWeb('q', 1)
    expect(result.result_text).toHaveLength(24_000)
    expect(result.truncated).toBe(true)
    expect(result.sources).toEqual([])
  })
  it('covers initialization with the total timeout and supports cancellation', async () => {
    vi.useFakeTimers()
    const { searchAssistantWeb } = await import('../assistantWebSearch')
    mocks.connect.mockImplementation(
      (_transport, { signal }) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
    )
    const outcome = searchAssistantWeb('q', 1).catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(20_001)
    expect(await outcome).toContain('20 seconds')
    expect(mocks.call).not.toHaveBeenCalled()
    const abort = new AbortController()
    abort.abort(new Error('user stopped'))
    await expect(searchAssistantWeb('q', 1, abort.signal)).rejects.toThrow('user stopped')
  })
  it('respects 429 cooldown without another request or credentials', async () => {
    const { searchAssistantWeb } = await import('../assistantWebSearch')
    const fetcher = vi.fn(async () => new Response('limited', { status: 429, headers: { 'retry-after': '120' } }))
    vi.stubGlobal('fetch', fetcher)
    mocks.connect.mockImplementation(async () => {
      const item = mocks.transports.at(-1)
      await item.options.fetch(item.url, {})
      throw Object.assign(new Error('limited'), { code: 429 })
    })
    await expect(searchAssistantWeb('q', 1)).rejects.toThrow('429')
    await expect(searchAssistantWeb('q', 1)).rejects.toThrow('rate limited')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error' })
  })
})
