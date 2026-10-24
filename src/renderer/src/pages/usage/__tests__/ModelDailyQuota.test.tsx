import type { UsageSource } from '@renderer/services/UsageStatisticsService'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import zh from '../../../i18n/locales/zh-cn.json'
import ModelDailyQuota from '../ModelDailyQuota'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@renderer/services/UsageStatisticsService', () => ({ fetchModelDailyQuota: mocks.fetch }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], zh) ?? key
  })
}))

const source: UsageSource = {
  id: 'one',
  label: 'Zen',
  apiHost: 'https://fixture.invalid/v1',
  apiKey: 'fixture',
  supported: true
}
beforeEach(() => mocks.fetch.mockReset())
afterEach(() => vi.restoreAllMocks())

describe('personal daily model allowance panel', () => {
  it('shows exhausted status and actual over-limit consumption without counting cache twice', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {}
    }))
    mocks.fetch.mockResolvedValue({
      date: '2026-10-24',
      timezone: 'Asia/Shanghai',
      models: [{ model: 'premium', limit: 100000, used: 140000, reserved: 0, remaining: 0, exhausted: true }]
    })
    render(<ModelDailyQuota source={source} revision={0} />)
    expect(await screen.findByText('premium')).toBeInTheDocument()
    expect(screen.getByText('140,000')).toBeInTheDocument()
    expect(screen.getByText('今日已用完')).toBeInTheDocument()
    expect(screen.getByRole('heading')).toHaveTextContent('北京时间')
  })
  it('does not display a previous key’s quota after switching keys', async () => {
    let resolveOld!: (value: unknown) => void
    mocks.fetch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          })
      )
      .mockResolvedValueOnce(undefined)
    const view = render(<ModelDailyQuota source={source} revision={0} />)
    view.rerender(<ModelDailyQuota source={{ ...source, id: 'two', apiKey: 'other' }} revision={0} />)
    resolveOld({ date: '2026-10-24', models: [{ model: 'private-old-model' }] })
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('private-old-model')).not.toBeInTheDocument()
  })
})
