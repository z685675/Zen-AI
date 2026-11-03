import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ToolStatusIndicator } from '../MessageAgentTools/GenericTools'
import { isBrowserHandoffResponse } from '../toolDisplay'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../ToolHeader', () => ({ default: () => null }))
vi.mock('@renderer/utils/file', () => ({ formatFileSize: () => '' }))

const handoff = { tabId: 'browser-tab', userAction: { reason: 'captcha' }, content: 'Call wait_for_user.' }

describe('browser tool access status', () => {
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
