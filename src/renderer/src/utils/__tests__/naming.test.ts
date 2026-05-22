import type { Provider, SystemProvider } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import {
  firstLetter,
  getBaseModelName,
  getBriefInfo,
  getDefaultGroupName,
  getFancyProviderName,
  getFirstCharacter,
  getLeadingEmoji,
  getLowerBaseModelName,
  isEmoji,
  removeLeadingEmoji,
  removeSpecialCharactersForTopicName,
  sanitizeProviderName,
  truncateText
} from '../naming'

describe('naming utils', () => {
  it('extracts and removes leading emoji correctly', () => {
    expect(firstLetter('Hello')).toBe('H')
    expect(firstLetter('😀Hello')).toBe('😀')
    expect(removeLeadingEmoji('😀Hello')).toBe('Hello')
    expect(getLeadingEmoji('😀Hello')).toBe('😀')
    expect(getLeadingEmoji('Hello')).toBe('')
  })

  it('detects emoji-only values and ignores urls/data uris', () => {
    expect(isEmoji('😀')).toBe(true)
    expect(isEmoji('😀Hello')).toBe(false)
    expect(isEmoji('Hello')).toBe(false)
    expect(isEmoji('data:image/png;base64,...')).toBe(false)
    expect(isEmoji('https://example.com')).toBe(false)
  })

  it('sanitizes topic and provider names', () => {
    expect(removeSpecialCharactersForTopicName('Hello\nWorld')).toBe('Hello World')
    expect(sanitizeProviderName('My Provider <test>:name')).toBe('My-Provider-testname')
  })

  it('sanitizes provider names for env vars with non-ASCII fallback', () => {
    expect(sanitizeProviderName('Provider/Name')).toBe('ProviderName')
    expect(sanitizeProviderName('测试')).toMatch(/^p_[a-z0-9]+$/)
    expect(sanitizeProviderName('🎉provider')).toBe('provider')
    expect(sanitizeProviderName('日本語Provider')).toBe('Provider')
    expect(sanitizeProviderName('foo@bar+baz(test)')).toBe('foobarbaztest')
    expect(sanitizeProviderName('my.provider')).toBe('my.provider')
  })

  it('extracts default group names across provider rules', () => {
    expect(getDefaultGroupName('group/model')).toBe('group')
    expect(getDefaultGroupName('group:model')).toBe('group')
    expect(getDefaultGroupName('foo bar')).toBe('foo')
    expect(getDefaultGroupName('group-subgroup-model')).toBe('group-subgroup')
    expect(getDefaultGroupName('Qwen/Qwen3-32B', 'aihubmix')).toBe('qwen')
    expect(getDefaultGroupName('gpt-4.1-mini', 'foobar')).toBe('gpt-4.1')
    expect(getDefaultGroupName('o3', 'openai')).toBe('o3')
  })

  it('extracts base model names and lower-case variants', () => {
    expect(getBaseModelName('DeepSeek/DeepSeek-R1')).toBe('DeepSeek-R1')
    expect(getBaseModelName('org/team/group/model')).toBe('model')
    expect(getLowerBaseModelName('DeepSeek/DeepSeek-R1')).toBe('deepseek-r1')
    expect(getLowerBaseModelName('gpt-4:free')).toBe('gpt-4')
    expect(getLowerBaseModelName('agent/gpt-4(free)')).toBe('gpt-4')
    expect(getLowerBaseModelName('local/kimi-k2.5:cloud')).toBe('kimi-k2.5')
  })

  it('normalizes fireworks model ids', () => {
    expect(getLowerBaseModelName('accounts/fireworks/models/deepseek-v3p2')).toBe('deepseek-v3.2')
    expect(getLowerBaseModelName('accounts/fireworks/models/deepseek-v3p1p2')).toBe('deepseek-v3.1.2')
    expect(getLowerBaseModelName('openai/deepseek-v3p2')).toBe('deepseek-v3p2')
  })

  it('returns characters and brief text summaries', () => {
    expect(getFirstCharacter('Hello')).toBe('H')
    expect(getFirstCharacter('😀Hello')).toBe('😀')
    expect(getBriefInfo('Short text', 20)).toBe('Short text')
    expect(getBriefInfo('This is a long text that needs truncation', 10)).toBe('This is a...')
  })

  it('resolves fancy provider names', () => {
    const systemProvider: SystemProvider = {
      id: 'dashscope',
      type: 'openai',
      name: 'ignored',
      apiHost: 'host',
      apiKey: 'key',
      models: [],
      isSystem: true
    }

    const customProvider: Provider = {
      id: 'custom',
      type: 'openai',
      name: 'Custom Provider',
      apiHost: 'host',
      apiKey: 'key',
      models: []
    }

    expect(getFancyProviderName(systemProvider)).toBe('Alibaba Cloud')
    expect(getFancyProviderName(customProvider)).toBe('Custom Provider')
  })

  it('truncates text while respecting boundaries where possible', () => {
    expect(truncateText('Hello')).toBe('Hello')
    expect(truncateText('Short text', { minLength: 20 })).toBe('Short text')
    expect(truncateText('First sentence. Second sentence. Third sentence.', { minLength: 10, maxLength: 40 })).toBe(
      'First sentence. Second sentence.'
    )
    expect(
      truncateText('This is a very long sentence without punctuation markers', { minLength: 10, maxLength: 30 })
    ).toBe('This is a very long sentence')
  })
})
