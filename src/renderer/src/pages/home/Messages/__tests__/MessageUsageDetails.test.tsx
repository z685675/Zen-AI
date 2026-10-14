import type { Message } from '@renderer/types/newMessage'
import type { OpenCodeTurnDiagnostics } from '@shared/agents/opencodeDiagnostics'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const emit = vi.hoisted(() => vi.fn())
vi.mock('@renderer/services/EventService', () => ({
  EventEmitter: { emit },
  EVENT_NAMES: { LOCATE_MESSAGE: 'locate' }
}))
vi.mock('react-i18next', async () => {
  const { default: locale } = await import('@renderer/i18n/locales/zh-cn.json')
  return {
    useTranslation: () => ({
      t: (key: string, values?: Record<string, unknown>) => {
        const template = key.split('.').reduce((object: any, field) => object?.[field], locale) ?? key
        return template.replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => String(values?.[name] ?? ''))
      }
    })
  }
})
import MessageTokens from '../MessageTokens'

const data: OpenCodeTurnDiagnostics = {
  version: 1,
  providerId: 'local-provider',
  modelId: 'gemini-test',
  usage: { input: 1000, output: 100, cacheRead: 800, reasoning: 30 },
  observedRequests: 1,
  reportedRequests: 1,
  inputReports: 1,
  outputReports: 1,
  cacheReadReports: 1,
  cacheWriteReports: 0,
  incompleteRequests: 0,
  performance: {
    outcome: 'completed',
    totalMs: 1800,
    preparationMs: 100,
    upstreamRequests: 1,
    upstreamHeaderWaitMs: 400,
    upstreamRequestMs: 1500,
    retryEvents: 0,
    toolCalls: 1,
    completedToolObservedMs: 300,
    unfinishedTools: 0
  }
}
const message = {
  id: 'reply',
  role: 'assistant',
  usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, cached_tokens: 800 },
  providerMetadata: {
    opencodeDiagnostics: data,
    responseTiming: { elapsedMs: 2000, firstTokenMs: 500, outcome: 'completed' }
  }
} as Message

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }))
  })
})

describe('read-only usage details', () => {
  it('preserves compact stats and expands actual counters, coverage and correct message timer on demand', async () => {
    render(<MessageTokens message={message} />)
    expect(screen.getByText('输入 1,000 · 输出 100 · 缓存 800')).toBeVisible()
    expect(screen.queryByText('缓存与用量诊断')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '详情' }))
    await waitFor(() => expect(screen.getByText('缓存与用量诊断')).toBeVisible())
    expect(screen.getByText('80.0%')).toBeVisible()
    expect(screen.getByText('2.00s')).toBeVisible()
    expect(screen.getByText('0.50s')).toBeVisible()
    expect(screen.getByText('gemini-test')).toBeVisible()
    expect(screen.getByText('local-provider')).toBeVisible()
    expect(screen.getByText(/Token 用量不等于账单/)).toBeVisible()
    expect(emit).not.toHaveBeenCalled()
  })
  it('does not convert unreported native cache zero into a real upstream zero or compute a partial rate', async () => {
    render(
      <MessageTokens
        message={{
          ...message,
          usage: { ...message.usage!, cached_tokens: 0 },
          providerMetadata: {
            ...message.providerMetadata,
            opencodeDiagnostics: { ...data, cacheReadReports: 0, usage: { input: 1000, output: 100 } }
          }
        }}
      />
    )
    expect(screen.getByText('输入 1,000 · 输出 100 · 缓存 —')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '详情' }))
    await waitFor(() => expect(screen.getByText(/部分请求缺少或未完整报告用量/)).toBeVisible())
    expect(screen.getAllByText('未知').length).toBeGreaterThan(1)
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument()
  })
  it('leaves old messages and corrupt diagnostic metadata with no fabricated detail button', () => {
    render(
      <MessageTokens message={{ ...message, providerMetadata: { opencodeDiagnostics: { version: 99 } } as any }} />
    )
    expect(screen.queryByRole('button', { name: '详情' })).not.toBeInTheDocument()
  })
})
