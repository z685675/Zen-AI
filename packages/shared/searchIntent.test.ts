import { describe, expect, it } from 'vitest'

import { classifyRealtimeSearchIntent, sanitizeWebSearchQuery } from './searchIntent'

describe('classifyRealtimeSearchIntent', () => {
  it.each([
    '请搜索 OpenAI 最新发布',
    '明天南京天气怎么样',
    '现在美元兑人民币汇率是多少',
    '现在北京时间是几点',
    '这个 npm 包的最新版本是什么',
    '现在B站周榜前十是什么视频',
    '今日微博热点',
    '请总结今日金融财经新闻',
    '过去24小时 AI 行业有哪些动态',
    '最近 OpenAI 有什么新动向',
    '截至今天黄金价格走势怎么样',
    '总结 https://example.com/article'
  ])('requires search for current or explicit requests: %s', (input) => {
    expect(classifyRealtimeSearchIntent(input)).toBe('required')
  })

  it.each([
    '你好',
    '把下面这段话翻译成英文',
    '请润色这段产品介绍',
    '根据附件总结主要结论',
    '总结附件中的今日财经新闻',
    '把“今日微博热点”翻译成英文',
    '写一篇关于热点传播机制的文章',
    '我最近心情不好，陪我聊聊'
  ])('does not search for self-contained tasks: %s', (input) => {
    expect(classifyRealtimeSearchIntent(input)).toBe('not_needed')
  })

  it.each(['法国首都是什么', 'Docker 是什么'])('does not search stable questions: %s', (input) => {
    expect(classifyRealtimeSearchIntent(input)).toBe('not_needed')
  })

  it.each(['推荐一款适合写作的笔记软件', '对比两款主流手机'])(
    'leaves recommendations and changeable comparisons to the intent model: %s',
    (input) => {
      expect(classifyRealtimeSearchIntent(input)).toBe('uncertain')
    }
  )

  it('does not automatically search sensitive local or personal context', () => {
    expect(classifyRealtimeSearchIntent('总结工作区里的最新项目资料')).toBe('not_needed')
    expect(classifyRealtimeSearchIntent('查询账号 user@example.com 的当前状态')).toBe('not_needed')
  })

  it('allows explicit search requests but redacts sensitive query values', () => {
    const query =
      '请搜索账号 user@example.com，手机号 13812345678，API Key: sk-1234567890abcdef 和文件 C:\\Users\\me\\secret.txt'

    expect(classifyRealtimeSearchIntent(query)).toBe('required')
    expect(sanitizeWebSearchQuery(query)).toBe(
      '请搜索账号 [REDACTED_EMAIL]，手机号 [REDACTED_PHONE]，API Key: [REDACTED] 和文件 [LOCAL_PATH]'
    )
  })
})
