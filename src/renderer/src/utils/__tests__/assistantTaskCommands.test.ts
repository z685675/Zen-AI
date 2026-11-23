import type { TFunction } from 'i18next'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/services/QuickPhraseService', () => ({
  default: {
    getAll: async () => [
      { title: '/审阅报告', content: '审阅以下内容：$ARGUMENTS' },
      { title: '普通短语', content: '普通模板' }
    ]
  }
}))

import { expandAssistantTaskCommand, selectAssistantTaskCommand } from '../assistantTaskCommands'

const t = ((key: string) => key) as TFunction

describe('assistant task commands', () => {
  it('expands built-in and custom templates with literal arguments and preserves ordinary input', async () => {
    expect(await expandAssistantTaskCommand('/review 第二章', t)).toBe('assistantTaskCommands.reviewPrompt\n\n第二章')
    expect(await expandAssistantTaskCommand('/审阅报告 $&', t)).toBe('审阅以下内容：$&')
    expect(await expandAssistantTaskCommand('/tmp/report.txt', t)).toBe('/tmp/report.txt')
    expect(await expandAssistantTaskCommand('/unknown argument', t)).toBe('/unknown argument')
    expect(selectAssistantTaskCommand('/tmp/report.txt', '/review')).toBe('/review /tmp/report.txt')
  })
})
