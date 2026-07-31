import type { Topic } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import WebSearchButton from '../WebSearchButton'

const onTopicChange = vi.fn()
const toastInfo = vi.fn()

vi.mock('@renderer/components/Buttons', () => ({
  ActionIconButton: ({ children, active, ...props }: any) => (
    <button type="button" data-active={active ? 'true' : 'false'} {...props}>
      {children}
    </button>
  )
}))

vi.mock('antd', () => ({
  Tooltip: ({ children }: any) => children
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'chat.input.web_search.label' ? 'Web Search' : key)
  })
}))

const createTopic = (enableWebSearch = false): Topic => ({
  id: 'topic-1',
  assistantId: 'assistant-1',
  name: 'Topic',
  createdAt: '2026-07-31T00:00:00.000Z',
  updatedAt: '2026-07-31T00:00:00.000Z',
  messages: [],
  enableWebSearch
})

describe('WebSearchButton', () => {
  beforeEach(() => {
    onTopicChange.mockReset()
    toastInfo.mockReset()
    ;(window as any).toast = { ...(window as any).toast, info: toastInfo }
  })

  it('enables search only for the current topic', () => {
    const topic = createTopic()
    render(<WebSearchButton topic={topic} onTopicChange={onTopicChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Web Search' }))

    expect(onTopicChange).toHaveBeenCalledWith({
      ...topic,
      enableWebSearch: true
    })
    expect(toastInfo).toHaveBeenCalledWith('chat.input.web_search.toast_enabled')
  })

  it('disables search only for the current topic', () => {
    const topic = createTopic(true)
    render(<WebSearchButton topic={topic} onTopicChange={onTopicChange} />)

    const button = screen.getByRole('button', { name: 'Web Search' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(button)

    expect(onTopicChange).toHaveBeenCalledWith({
      ...topic,
      enableWebSearch: false
    })
    expect(toastInfo).toHaveBeenCalledWith('chat.input.web_search.toast_disabled')
  })
})
