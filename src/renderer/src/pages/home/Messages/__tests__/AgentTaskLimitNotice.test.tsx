import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', async () => {
  const { default: locale } = await import('@renderer/i18n/locales/zh-cn.json')
  return {
    initReactI18next: { type: '3rdParty', init: vi.fn() },
    useTranslation: () => ({
      t: (_key: string, { limit }: { limit: number }) => locale.agent.task_limit.replace('{{limit}}', String(limit))
    })
  }
})

import AgentTaskLimitNotice from '../Blocks/AgentTaskLimitNotice'

describe('local assistant capacity notice', () => {
  it.each([1, 3])('shows the combined %i-task limit without a model-failure card', (limit) => {
    render(<AgentTaskLimitNotice limit={limit} />)
    expect(screen.getByRole('status')).toHaveTextContent(`最多同时运行 ${limit} 个任务`)
    expect(screen.getByRole('status')).toHaveTextContent('新版和弃用助手合计')
    expect(screen.getByRole('status')).toHaveTextContent('完成或停止其他任务')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText(/网络|失败|重试/)).not.toBeInTheDocument()
  })
})
