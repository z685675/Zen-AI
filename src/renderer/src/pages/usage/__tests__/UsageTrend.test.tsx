import type { UsageStatistics } from '@renderer/services/UsageStatisticsService'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import dayjs from 'dayjs'
import { describe, expect, it, vi } from 'vitest'

import translations from '../../../i18n/locales/zh-cn.json'
import UsageTrend from '../UsageTrend'
import { emptyUsageMetrics, groupUsageDays, type UsageInterval } from '../usageUtils'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], translations) ?? key,
    i18n: { language: 'zh-CN' }
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

const records: UsageStatistics['days'] = [
  {
    ...emptyUsageMetrics(),
    date: '2026-10-14',
    input_tokens: 130000,
    output_tokens: 5000,
    total_tokens: 135000,
    cache_tokens: 120000,
    request_count: 2,
    cache_known_requests: 2
  },
  {
    ...emptyUsageMetrics(),
    date: '2026-10-15',
    input_tokens: 500,
    output_tokens: 50,
    total_tokens: 550,
    cache_tokens: 400,
    request_count: 1,
    cache_known_requests: 1
  }
]
const group = (interval: UsageInterval = 'day', days = records) =>
  groupUsageDays(days, dayjs('2026-10-14'), dayjs('2026-10-16'), interval)
const column = (date: string) => screen.getByRole('button', { name: new RegExp(`^${date}`) })

describe('Usage trend details', () => {
  it('opens immediately over the whole date column and shows all three exact counts, then switches dates', async () => {
    render(<UsageTrend days={group()} />)
    const first = column('2026-10-14')
    expect(first.tagName).toBe('rect')
    expect(Number(first.getAttribute('width'))).toBeGreaterThan(100)
    expect(first).toHaveAttribute('height', '194')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.mouseEnter(first)
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('2026-10-14')
    expect(within(tooltip).getByText('输入 Token')).toBeInTheDocument()
    expect(within(tooltip).getByText('输出 Token')).toBeInTheDocument()
    expect(within(tooltip).getByText('缓存 Token')).toBeInTheDocument()
    expect(within(tooltip).getByText('130,000')).toBeInTheDocument()
    expect(within(tooltip).getByText('5,000')).toBeInTheDocument()
    expect(within(tooltip).getByText('120,000')).toBeInTheDocument()
    expect(within(tooltip).queryByText('250,000')).not.toBeInTheDocument()
    fireEvent.mouseLeave(first)
    fireEvent.mouseEnter(column('2026-10-15'))
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('2026-10-15'))
    const next = screen.getByRole('tooltip')
    expect(within(next).getByText('500')).toBeInTheDocument()
    expect(within(next).getByText('50')).toBeInTheDocument()
    expect(within(next).getByText('400')).toBeInTheDocument()
    fireEvent.mouseLeave(column('2026-10-15'))
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  it.each(['week', 'month'] as const)(
    'shows the selected date boundaries and aggregate in the %s view',
    async (interval) => {
      render(<UsageTrend days={group(interval)} />)
      fireEvent.mouseEnter(column('2026-10-14 — 2026-10-16'))
      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip).toHaveTextContent('2026-10-14 — 2026-10-16')
      expect(within(tooltip).getByText('130,500')).toBeInTheDocument()
      expect(within(tooltip).getByText('5,050')).toBeInTheDocument()
      expect(within(tooltip).getByText('120,400')).toBeInTheDocument()
    }
  )

  it('distinguishes unknown cache, a known partial count, and a genuine zero-usage date', async () => {
    const days = records.map((day, index) => ({
      ...day,
      cache_tokens: index === 0 ? null : 400,
      cache_known_requests: 0
    }))
    render(<UsageTrend days={group('day', days)} />)
    fireEvent.mouseEnter(column('2026-10-14'))
    let tooltip = await screen.findByRole('tooltip')
    expect(within(tooltip).getByText('—')).toBeInTheDocument()
    expect(tooltip).toHaveTextContent(translations.usage_statistics.cache_unknown)
    fireEvent.mouseLeave(column('2026-10-14'))
    fireEvent.mouseEnter(column('2026-10-15'))
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('≥ 400'))
    tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent(translations.usage_statistics.cache_partial)
    fireEvent.mouseLeave(column('2026-10-15'))
    fireEvent.mouseEnter(column('2026-10-16'))
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('2026-10-16'))
    tooltip = screen.getByRole('tooltip')
    expect(within(tooltip).getAllByText('0')).toHaveLength(3)
    expect(tooltip).not.toHaveTextContent(translations.usage_statistics.cache_unknown)
    expect(tooltip).not.toHaveTextContent('≥')
  })

  it('supports focus, keyboard dismissal/activation and clicking instead of precise pointer placement', async () => {
    render(<UsageTrend days={group()} />)
    const first = column('2026-10-14')
    fireEvent.focus(first)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('130,000')
    fireEvent.keyDown(first, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
    fireEvent.keyDown(first, { key: 'Enter' })
    expect(await screen.findByRole('tooltip')).toHaveTextContent('130,000')
    fireEvent.keyDown(first, { key: ' ' })
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
    fireEvent.blur(first)
    fireEvent.click(column('2026-10-15'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('500')
    fireEvent.click(column('2026-10-15'))
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  it('closes stale details when results change or the chart is removed', async () => {
    const view = render(<UsageTrend days={group()} />)
    fireEvent.mouseEnter(column('2026-10-14'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('130,000')
    const next = group('day', [{ ...records[0], input_tokens: 200000 }])
    view.rerender(<UsageTrend days={next} />)
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
    fireEvent.mouseEnter(column('2026-10-14'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('200,000')
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('130,000')
    view.unmount()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('keeps a single date easy to inspect, including fully overlapping points, and handles empty charts', async () => {
    const days = groupUsageDays([], dayjs('2026-10-14'), dayjs('2026-10-14'), 'day')
    const view = render(<UsageTrend days={days} />)
    const target = column('2026-10-14')
    expect(Number(target.getAttribute('width'))).toBeGreaterThan(800)
    fireEvent.mouseEnter(target)
    expect(within(await screen.findByRole('tooltip')).getAllByText('0')).toHaveLength(3)
    view.rerender(<UsageTrend days={[]} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
    expect(screen.getByRole('group', { name: '用量趋势' }).outerHTML).not.toMatch(/NaN|Infinity/)
  })
})
