import type { Message } from '@renderer/types/newMessage'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/services/EventService', () => ({
  EventEmitter: { emit: vi.fn() },
  EVENT_NAMES: { LOCATE_MESSAGE: 'locate' }
}))
vi.mock('react-i18next', async () => {
  const { default: locale } = await import('@renderer/i18n/locales/zh-cn.json')
  const labels = locale.settings.messages as Record<string, string>
  return {
    useTranslation: () => ({
      t: (key: string, values?: Record<string, string>) => {
        const template = labels[key.split('.').at(-1)!]
        return template.replace(/\{\{(\w+)\}\}/g, (_match: string, name: string) => values?.[name] ?? '')
      }
    })
  }
})

import MessageTokens from '../MessageTokens'

const message = {
  id: 'assistant-stats',
  role: 'assistant',
  model: { id: 'gemini-test', endpoint_type: 'openai' },
  usage: { prompt_tokens: 13729, completion_tokens: 46, total_tokens: 13775, cached_tokens: 12000 },
  providerMetadata: {
    responseTiming: { firstTokenMs: 1250, elapsedMs: 5500, outcome: 'completed' }
  }
} as Message

describe('compact message statistics', () => {
  it('shows only input, output, cache reads and full-round timing', () => {
    const { container } = render(<MessageTokens message={message} />)
    expect(screen.getByText('输入 13,729 · 输出 46 · 缓存 12,000')).toBeInTheDocument()
    expect(screen.getByText('首字 1.25s · 用时 5.50s')).toBeInTheDocument()
    expect(container.textContent).not.toContain('Path:')
    expect(container.textContent).not.toContain('OpenAI')
    expect(container.textContent).not.toContain('13775')
    expect(container.textContent).not.toMatch(/\(|\)|\b(in|out|cache|first|total)\b/)
  })

  it('does not add cache writes or count duplicate read fields twice', () => {
    render(
      <MessageTokens
        message={{
          ...message,
          usage: { ...message.usage!, cached_tokens: 100, cache_read_tokens: 100, cache_write_tokens: 50 }
        }}
      />
    )
    expect(screen.getByText('输入 13,729 · 输出 46 · 缓存 100')).toBeInTheDocument()
  })

  it('distinguishes missing cache statistics from an explicit zero', () => {
    const { rerender } = render(
      <MessageTokens message={{ ...message, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }} />
    )
    expect(screen.getByText('输入 10 · 输出 5 · 缓存 —')).toBeInTheDocument()
    rerender(
      <MessageTokens
        message={{ ...message, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 0 } }}
      />
    )
    expect(screen.getByText('输入 10 · 输出 5 · 缓存 0')).toBeInTheDocument()
  })

  it('still shows total elapsed time without upstream usage for a cancelled turn', () => {
    render(
      <MessageTokens
        message={
          {
            ...message,
            usage: undefined,
            providerMetadata: { responseTiming: { firstTokenMs: undefined, elapsedMs: 2300, outcome: 'cancelled' } }
          } as Message
        }
      />
    )
    expect(screen.getByText('输入 — · 输出 — · 缓存 —')).toBeInTheDocument()
    expect(screen.getByText('首字 — · 用时 2.30s')).toBeInTheDocument()
  })

  it('keeps user message token counts unchanged', () => {
    render(<MessageTokens message={{ ...message, role: 'user' }} />)
    expect(screen.getByText('Tokens: 13775')).toBeInTheDocument()
    expect(screen.queryByText(/首字/)).not.toBeInTheDocument()
  })
})
