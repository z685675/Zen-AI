import type { Provider } from '@renderer/types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import translations from '../../../i18n/locales/zh-cn.json'
import UsagePage from '../UsagePage'
import { emptyUsageMetrics } from '../usageUtils'

const mocks = vi.hoisted(() => ({ providers: [] as Provider[], usage: vi.fn() }))
const getComputedStyle = window.getComputedStyle.bind(window)
vi.mock('@renderer/hooks/useProvider', () => ({ useAllProviders: () => mocks.providers }))
vi.mock('../useUsageStatistics', () => ({ useUsageStatistics: mocks.usage }))
vi.mock('@renderer/components/app/Navbar', () => ({
  Navbar: ({ children }: { children: ReactNode }) => <nav>{children}</nav>,
  NavbarCenter: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], translations) ?? key,
    i18n: { language: 'zh-CN' }
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

describe('My usage page', () => {
  beforeEach(() => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => getComputedStyle(element))
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    )
    mocks.providers = [
      {
        id: 'zen',
        name: 'Zen API',
        apiHost: 'https://test.invalid/v1',
        apiKey: 'fake-key',
        type: 'new-api',
        enabled: true,
        models: []
      } as Provider
    ]
    mocks.usage.mockReset()
    mocks.usage.mockReturnValue({ stats: null, error: null, loading: false, updatedAt: null })
  })
  afterEach(() => vi.restoreAllMocks())
  it('shows inputs and cache separately, supports model search and time/scene controls', () => {
    const metrics = {
      ...emptyUsageMetrics(),
      input_tokens: 130000,
      output_tokens: 1000,
      total_tokens: 131000,
      cache_tokens: 120000,
      cache_read_tokens: 120000,
      request_count: 1,
      cache_known_requests: 1,
      cache_read_known_requests: 1
    }
    mocks.usage.mockReturnValue({
      stats: {
        summary: metrics,
        models: [
          { model: 'gpt-test', ...metrics },
          { model: 'gemini-test', ...metrics }
        ],
        days: []
      },
      error: null,
      loading: false,
      updatedAt: '12:00:01'
    })
    render(<UsagePage />)
    expect(screen.getByRole('heading', { name: '我的用量' })).toBeInTheDocument()
    expect(screen.getAllByText('130,000').length).toBeGreaterThan(0)
    expect(screen.getAllByText('120,000').length).toBeGreaterThan(0)
    expect(screen.queryByText('250,000')).not.toBeInTheDocument()
    expect(screen.getAllByText('92.3%').length).toBeGreaterThan(0)
    expect(screen.getByRole('group', { name: '用量趋势' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索模型' }), { target: { value: 'gemini' } })
    const table = screen.getByRole('table')
    expect(within(table).getByText('gemini-test')).toBeInTheDocument()
    expect(within(table).queryByText('gpt-test')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('AI 对话'))
    expect(mocks.usage.mock.lastCall?.[1].scene).toBe('chat')
    fireEvent.click(screen.getByText('智能助手'))
    expect(mocks.usage.mock.lastCall?.[1].scene).toBe('assistant')
    fireEvent.click(screen.getByText('今日'))
    const query = mocks.usage.mock.lastCall?.[1]
    expect(query.end - query.start).toBe(86399)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(mocks.usage.mock.lastCall?.[2]).toBe(1)
    expect(screen.queryByText(/数据来自 API 面板/)).not.toBeInTheDocument()
    expect(screen.queryByText('fake-key')).not.toBeInTheDocument()
  })
  it('distinguishes a loading failure, a genuine empty result, and initial setup', () => {
    mocks.usage.mockReturnValue({ stats: null, error: 'unavailable', loading: false, updatedAt: null })
    const view = render(<UsagePage />)
    expect(screen.getByRole('alert')).toHaveTextContent('暂时无法加载用量')
    expect(screen.queryByText('这段时间还没有用量记录')).not.toBeInTheDocument()
    mocks.usage.mockReturnValue({
      stats: { summary: emptyUsageMetrics(), days: [], models: [] },
      error: null,
      loading: false,
      updatedAt: null
    })
    view.rerender(<UsagePage />)
    expect(screen.getByText('这段时间还没有用量记录')).toBeInTheDocument()
    view.unmount()
    mocks.providers = []
    mocks.usage.mockReturnValue({ stats: null, error: null, loading: false, updatedAt: null })
    render(<UsagePage />)
    expect(screen.getByText('请先在模型服务中添加配置')).toBeInTheDocument()
  })
  it('keeps the waiting state visible until usage arrives', () => {
    mocks.usage.mockReturnValue({ stats: null, error: null, loading: true, updatedAt: null })
    render(<UsagePage />)
    expect(screen.getByRole('status')).toHaveTextContent('正在加载用量')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
