import { lookup } from 'node:dns/promises'

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

import { readAssistantWebpage } from '../assistantReadWebpage'

const html = (value: string) => new Response(value, { headers: { 'content-type': 'text/html; charset=utf-8' } })
let scope = 0
beforeEach(() => {
  scope++
  vi.mocked(lookup)
    .mockReset()
    .mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as never)
})

describe('managed public webpage reading', () => {
  it('extracts source sections without executing scripts or needing Python and preserves absolute citations', async () => {
    const request = vi.fn(async () =>
      html(
        '<title>Source</title><nav>Navigation</nav><article><h2>Findings</h2><p>Evidence 中文</p><a href="/original">Original</a><script>fetch("https://evil.example/")</script><img src="data:image/png;base64,secret" alt="chart"></article>'
      )
    )
    const result = await readAssistantWebpage(
      { url: 'https://source.example/paper' },
      `scope-${scope}`,
      undefined,
      request
    )
    expect(result).toMatchObject({ status: 'complete', title: 'Source', next_offset: null, cached: false })
    expect(result.text).toContain('Evidence 中文')
    expect(result.text).toContain('https://source.example/original')
    expect(result.text).not.toMatch(/evil|base64|secret|Navigation/)
    expect(request).toHaveBeenCalledOnce()
  })

  it('continues a bounded snapshot and targets sections without downloading it again', async () => {
    const request = vi.fn(async () =>
      html(
        `<article><h2>Evidence</h2><p>${'a'.repeat(800)}</p><section id="limits">Important limits</section></article>`
      )
    )
    const args = { url: 'https://source.example/long', max_chars: 256 }
    const first = await readAssistantWebpage(args, `scope-${scope}`, undefined, request)
    const next = await readAssistantWebpage(
      { ...args, offset: first.next_offset },
      `scope-${scope}`,
      undefined,
      request
    )
    const section = await readAssistantWebpage(
      { url: args.url, selector: '#limits' },
      `scope-${scope}`,
      undefined,
      request
    )
    expect(first).toMatchObject({ status: 'partial', next_offset: 256, returned_chars: 256 })
    expect(next).toMatchObject({ cached: true, offset: 256 })
    expect(section.text).toBe('Important limits')
    expect(section.partial).toBe(true)
    expect(request).toHaveBeenCalledOnce()
  })

  it('locates sections and avoids repeating text from nested selectors', async () => {
    const request = vi.fn(async () =>
      html(
        '<article><h1>Overview</h1><p>Context</p><section><h2>Methods</h2><p>Method evidence</p></section></article>'
      )
    )
    const args = { url: 'https://source.example/sections', selector: 'article, article section' }
    const first = await readAssistantWebpage(args, `scope-${scope}`, undefined, request)
    expect(first.text.match(/Method evidence/g)).toHaveLength(1)
    const location = first.section_offsets.find((section) => section.title === 'Methods')!
    const next = await readAssistantWebpage({ ...args, offset: location.offset }, `scope-${scope}`, undefined, request)
    expect(next.text).toBe('## Methods\n\nMethod evidence')
    expect(next.partial).toBe(true)
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([401, 403, 404, 410, 429])(
    'remembers HTTP %s failure within this scope and does not repeat the request',
    async (status) => {
      const request = vi.fn(async () => new Response('', { status }))
      const args = { url: 'https://source.example/blocked' }
      await expect(readAssistantWebpage(args, `scope-${scope}`, undefined, request)).rejects.toThrow(`HTTP ${status}`)
      await expect(readAssistantWebpage(args, `scope-${scope}`, undefined, request)).rejects.toThrow('Do not repeat')
      expect(request).toHaveBeenCalledOnce()
      await expect(readAssistantWebpage(args, `other-${scope}`, undefined, request)).rejects.toThrow(`HTTP ${status}`)
      expect(request).toHaveBeenCalledTimes(2)
    }
  )

  it('deduplicates overlapping reads of the same source', async () => {
    const request = vi.fn(async () => html('<article>Reusable evidence</article>'))
    const results = await Promise.all(
      [1, 2].map(() =>
        readAssistantWebpage({ url: 'https://source.example/shared' }, `scope-${scope}`, undefined, request)
      )
    )
    expect(request).toHaveBeenCalledOnce()
    expect(results[0].text).toBe(results[1].text)
  })

  it('does not call an empty JavaScript shell readable evidence', async () => {
    const request = vi.fn(async () => html('<main><script>loadArticle()</script></main>'))
    const args = { url: 'https://source.example/javascript' }
    await expect(readAssistantWebpage(args, `scope-${scope}`, undefined, request)).rejects.toThrow(
      'No readable source text'
    )
    await expect(readAssistantWebpage(args, `scope-${scope}`, undefined, request)).rejects.toThrow(
      'No readable source text'
    )
    expect(request).toHaveBeenCalledOnce()
  })

  it('keeps unsupported page CSS out of application error logs', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const result = await readAssistantWebpage(
        { url: 'https://source.example/css' },
        `scope-${scope}`,
        undefined,
        async () => html('<style>div { invalid { </style><article>Actual evidence</article>')
      )
      expect(result.text).toBe('Actual evidence')
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  it('preserves source table rows and columns instead of flattening numeric evidence', async () => {
    const result = await readAssistantWebpage(
      { url: 'https://source.example/table' },
      `scope-${scope}`,
      undefined,
      async () =>
        html(
          '<article><table><tr><th>Parameter</th><th>Value</th></tr><tr><td>Threshold</td><td>120 MPa</td></tr><tr><td>Cycles</td><td>100000</td></tr></table></article>'
        )
    )
    expect(result.text).toMatch(/\|\s*Parameter\s*\|\s*Value\s*\|/)
    expect(result.text).toMatch(/\|\s*Threshold\s*\|\s*120 MPa\s*\|/)
    expect(result.text).toMatch(/\|\s*Cycles\s*\|\s*100000\s*\|/)
  })

  it('rejects CAPTCHA and binary responses rather than claiming source evidence', async () => {
    await expect(
      readAssistantWebpage({ url: 'https://source.example/challenge' }, `scope-${scope}`, undefined, async () =>
        html('<title>Just a moment...</title><form id="challenge-form">Verify</form>')
      )
    ).rejects.toThrow('not article evidence')
    await expect(
      readAssistantWebpage(
        { url: 'https://source.example/binary' },
        `scope-${scope}`,
        undefined,
        async () => new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } })
      )
    ).rejects.toThrow('read_paper')
    await expect(
      readAssistantWebpage({ url: 'https://source.example/large' }, `scope-${scope}`, undefined, async () =>
        html('x'.repeat(2 * 1024 * 1024 + 1))
      )
    ).rejects.toThrow('download limit')
  })

  it.each([
    '<title>pmc.ncbi.nlm.nih.gov</title><h1>Cookies must be enabled</h1><p>Enable cookies for pmc.ncbi.nlm.nih.gov and reload this page to continue.</p>',
    `<title>pmc.ncbi.nlm.nih.gov</title><h1>Cookies must be enabled</h1><p>Enable cookies for pmc.ncbi.nlm.nih.gov and reload this page to continue.</p><script>${'/* challenge code */'.repeat(400)}</script><style>${'/* styles */'.repeat(400)}</style>`,
    '<title>正在确认你是不是机器人！</title><main>Anubis protects this server using Proof-of-Work. Javascript required.</main>',
    '<title>HAL</title><script id="anubis_challenge" type="application/json">{}</script><main>Please wait</main>'
  ])('never accepts cookie or multilingual verification walls as article evidence', async (page) => {
    const request = vi.fn(async () => html(page))
    for (let repeat = 0; repeat < 2; repeat++) {
      await expect(
        readAssistantWebpage({ url: 'https://source.example/wall' }, `scope-${scope}`, undefined, request)
      ).rejects.toThrow('not article evidence')
    }
    expect(request).toHaveBeenCalledOnce()
  })

  it('preserves articles about verification and pages containing ordinary cookie notices', async () => {
    const result = await readAssistantWebpage(
      { url: 'https://source.example/security' },
      `scope-${scope}`,
      undefined,
      async () =>
        html(
          '<title>Understanding CAPTCHA and Anubis</title><aside>Enable cookies for a better experience.</aside><article><h1>How to verify you are human</h1><p>CAPTCHA, Proof-of-Work and Anubis are discussed in this research article.</p></article>'
        )
    )
    expect(result.status).toBe('complete')
    expect(result.text).toContain('research article')
  })

  it('does not confuse a cookie-gate example in a substantial article with a verification wall', async () => {
    const result = await readAssistantWebpage(
      { url: 'https://source.example/cookie-explanation' },
      `scope-${scope}`,
      undefined,
      async () =>
        html(
          `<article><h1>Cookies must be enabled</h1><p>Enable cookies and reload this page is a common instruction.</p><p>${'An explanation of browser storage and accessibility. '.repeat(100)}</p></article>`
        )
    )
    expect(result.text).toContain('browser storage and accessibility')
    expect(result.status).toBe('complete')
  })

  it('fails closed for private redirects and cancellation before a request', async () => {
    const request = vi.fn(
      async () => new Response('', { status: 302, headers: { location: 'https://127.0.0.1/admin' } })
    )
    await expect(
      readAssistantWebpage({ url: 'https://source.example/redirect' }, `scope-${scope}`, undefined, request)
    ).rejects.toThrow('Private/local')
    expect(request).toHaveBeenCalledOnce()
    const controller = new AbortController()
    controller.abort()
    await expect(
      readAssistantWebpage({ url: 'https://source.example/cancelled' }, `scope-${scope}`, controller.signal, request)
    ).rejects.toThrow()
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not silently redownload an expired continuation or accept invalid selectors', async () => {
    const request = vi.fn(async () => html('<article>Evidence</article>'))
    await expect(
      readAssistantWebpage({ url: 'https://source.example/missing', offset: 12 }, `scope-${scope}`, undefined, request)
    ).rejects.toThrow('snapshot expired')
    expect(request).not.toHaveBeenCalled()
    await expect(
      readAssistantWebpage(
        { url: 'https://source.example/missing', selector: '[' },
        `scope-${scope}`,
        undefined,
        request
      )
    ).rejects.toThrow('Invalid CSS')
    await expect(
      readAssistantWebpage(
        { url: 'https://source.example/missing', selector: '#none' },
        `scope-${scope}`,
        undefined,
        request
      )
    ).rejects.toThrow('No matching')
    expect(request).toHaveBeenCalledOnce()
  })
})
