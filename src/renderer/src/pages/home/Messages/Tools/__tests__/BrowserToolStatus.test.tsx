import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ToolStatusIndicator } from '../MessageAgentTools/GenericTools'
import { isBrowserHandoffResponse } from '../toolDisplay'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../ToolHeader', () => ({ default: () => null }))
vi.mock('@renderer/utils/file', () => ({ formatFileSize: () => '' }))

const handoff = { tabId: 'browser-tab', userAction: { reason: 'captcha' }, content: 'Call wait_for_user.' }

describe('browser tool access status', () => {
  it.each([
    [
      { status: 'unavailable', executed: false, service: 'Exa public MCP', reason: 'rate_limit' },
      'message.tools.search_limited'
    ],
    [{ status: 'unavailable', executed: false, service: 'Crossref' }, 'message.tools.search_limited'],
    [{ status: 'timed_out', executed: false, service: 'Zen browser handoff' }, 'message.tools.handoff_timed_out']
  ])('shows unavailable operations without a success label', (value, key) => {
    render(
      <ToolStatusIndicator
        status="done"
        label="已完成"
        response={{ content: [{ type: 'text', text: JSON.stringify(value) }] }}
      />
    )
    expect(screen.getByText(key)).toBeInTheDocument()
    expect(screen.queryByText('已完成')).toBeNull()
  })
  it.each([handoff, JSON.stringify(handoff), { content: [{ type: 'text', text: JSON.stringify(handoff) }] }])(
    'shows user intervention instead of a completed page read',
    (response) => {
      render(<ToolStatusIndicator status="done" label="网页已打开" response={response} />)
      expect(screen.getByText('browser.handoff_title')).toBeInTheDocument()
      expect(screen.queryByText('网页已打开')).toBeNull()
    }
  )

  it('does not interpret article text or an ordinary mention of CAPTCHA as a handoff', () => {
    expect(isBrowserHandoffResponse('An article about CAPTCHA.')).toBe(false)
    expect(isBrowserHandoffResponse({ tabId: 'tab', content: JSON.stringify(handoff) })).toBe(false)
    render(<ToolStatusIndicator status="done" label="网页已打开" response={{ tabId: 'tab', content: 'Article' }} />)
    expect(screen.getByText('网页已打开')).toBeInTheDocument()
  })
})
