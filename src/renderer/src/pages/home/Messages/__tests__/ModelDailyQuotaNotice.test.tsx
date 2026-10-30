import type { Message } from '@renderer/types/newMessage'
import type { ModelDailyTurnResult } from '@shared/utils/modelDailyQuotaTurn'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options: { model: string }) => `${options.model} 今日额度已达上限，请切换其他模型使用。`
  })
}))

import ModelDailyQuotaNotice from '../ModelDailyQuotaNotice'

const result: ModelDailyTurnResult = {
  model: 'gpt-test',
  date: '2026-10-29',
  current_date: '2026-10-29',
  limit: 100,
  used: 120,
  exhausted: true,
  extra_allowed: false,
  pending: false
}
const message = (results: unknown = [result]) => ({ providerMetadata: { modelDailyQuota: { results } } }) as Message

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-29T15:59:59Z'))
})
afterEach(() => vi.useRealTimers())

describe('post-task daily quota notice', () => {
  it('shows a small actionable notice only after the answer finishes', () => {
    const { rerender } = render(<ModelDailyQuotaNotice message={message()} processing />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    rerender(<ModelDailyQuotaNotice message={message()} processing={false} />)
    expect(screen.getByRole('status')).toHaveTextContent('gpt-test 今日额度已达上限，请切换其他模型使用。')
  })
  it.each([
    { results: [{ ...result, extra_allowed: true }] },
    { results: [{ ...result, pending: true }] },
    { results: [{ ...result, used: 99 }] },
    { results: [{ ...result, current_date: '2026-10-30' }] },
    { results: [{ ...result, date: '2026-10-28', current_date: '2026-10-28' }] },
    { results: [null] },
    { results: [{ exhausted: true }] },
    { results: undefined }
  ])('hides non-actionable, historical or malformed metadata %#', ({ results }) => {
    const value = results === undefined ? ({} as Message) : message(results)
    render(<ModelDailyQuotaNotice message={value} processing={false} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  it('removes yesterday’s notice at Beijing midnight even while the view stays open', async () => {
    render(<ModelDailyQuotaNotice message={message()} processing={false} />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
