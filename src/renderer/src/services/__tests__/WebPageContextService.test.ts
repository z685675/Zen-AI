import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  detectWebPageRequest,
  injectWebPageContext,
  loadWebPageContext,
  prepareWebPageMessages
} from '../WebPageContextService'

describe('WebPageContextService', () => {
  const readPage = vi.fn()

  beforeEach(() => {
    readPage.mockReset()
    window.api = {
      ...window.api,
      webPage: { read: readPage }
    }
  })

  it('treats a message containing only a URL as a webpage summary request', () => {
    expect(detectWebPageRequest('https://example.com/article。')).toMatchObject({
      urls: ['https://example.com/article'],
      isUrlOnly: true
    })
  })

  it('recognizes explicit webpage instructions in Chinese and English', () => {
    expect(detectWebPageRequest('请总结 https://example.com/article')).toMatchObject({ isUrlOnly: false })
    expect(detectWebPageRequest('Analyze this web page: https://example.com/article')).toMatchObject({
      isUrlOnly: false
    })
  })

  it('does not fetch a URL that is only mentioned in unrelated conversation', () => {
    expect(detectWebPageRequest('这个地址是 https://example.com，请告诉我怎么复制链接')).toBeUndefined()
  })

  it('limits extraction to three unique URLs', () => {
    const request = detectWebPageRequest(
      '总结 https://one.example https://two.example https://three.example https://four.example'
    )
    expect(request?.urls).toEqual(['https://one.example/', 'https://two.example/', 'https://three.example/'])
  })

  it('reads pages and creates an application-level context prompt', async () => {
    readPage
      .mockResolvedValueOnce({ url: 'https://example.com/', title: 'Example', content: '网页正文' })
      .mockResolvedValueOnce({ url: 'https://second.example/', title: 'Second', content: '第二篇正文' })

    const context = await loadWebPageContext('https://example.com/ https://second.example/')

    expect(readPage).toHaveBeenCalledTimes(2)
    expect(context?.prompt).toContain('网页正文')
    expect(context?.prompt).toContain('第二篇正文')
    expect(context?.prompt).toContain('直接阅读并总结网页')
  })

  it('injects the webpage context into the latest user message only', () => {
    const messages = [
      { role: 'user' as const, content: '旧问题' },
      { role: 'assistant' as const, content: '旧回答' },
      { role: 'user' as const, content: '请总结 https://example.com' }
    ]
    const context = {
      request: { urls: ['https://example.com/'], isUrlOnly: false, instruction: '请总结' },
      pages: [{ url: 'https://example.com/', title: 'Example', content: '正文' }],
      prompt: '<web-page-context>正文</web-page-context>'
    }

    const result = injectWebPageContext(messages, context)

    expect(result[0]).toEqual(messages[0])
    expect(result[1]).toEqual(messages[1])
    expect(result[2].content).toContain('<web-page-context>正文</web-page-context>')
  })

  it('fails clearly when no page content can be read', async () => {
    readPage.mockResolvedValue({ url: 'https://example.com/', title: 'Example', content: ' ' })

    await expect(loadWebPageContext('https://example.com')).rejects.toThrow('没有获取到可总结的正文内容')
  })

  it('prepares messages without changing the original user message object', async () => {
    readPage.mockResolvedValue({ url: 'https://example.com/', title: 'Example', content: '网页正文' })
    const messages = [{ role: 'user' as const, content: 'https://example.com' }]

    const result = await prepareWebPageMessages(messages)

    expect(result.context?.pages).toHaveLength(1)
    expect(messages[0].content).toBe('https://example.com')
    expect(result.messages[0].content).toContain('网页正文')
  })
})
