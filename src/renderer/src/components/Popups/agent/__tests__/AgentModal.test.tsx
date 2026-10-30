import { TopView } from '@renderer/components/TopView'
import type { AgentEntity } from '@renderer/types'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HTMLAttributes, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AgentModalPopup from '../AgentModal'

const mocks = vi.hoisted(() => ({ updateAgent: vi.fn(), addAgent: vi.fn() }))

vi.mock('@renderer/components/TopView', () => ({ TopView: { show: vi.fn(), hide: vi.fn() } }))
vi.mock('@renderer/components/AnthropicProviderListPopover', () => ({ default: () => null }))
vi.mock('@renderer/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@renderer/components/Scrollbar', () => ({
  default: (props: HTMLAttributes<HTMLDivElement>) => <div {...props} />
}))
vi.mock('@renderer/components/TooltipIcons', () => ({ HelpTooltip: () => null }))
vi.mock('@renderer/pages/agents/components/SelectAgentBaseModelButton', () => ({ default: () => null }))
vi.mock('@renderer/hooks/agents/useAgents', () => ({ useAgents: () => ({ addAgent: mocks.addAgent }) }))
vi.mock('@renderer/hooks/agents/useUpdateAgent', () => ({ useUpdateAgent: () => ({ updateAgent: mocks.updateAgent }) }))
vi.mock('@renderer/config/constant', () => ({ isWin: false }))
vi.mock('@renderer/utils/provider', () => ({ getAnthropicSupportedProviders: () => [] }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updateAgent.mockResolvedValue({ id: DEFAULT_OPENCODE_AGENT_ID })
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => getComputedStyle(element))
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function openSettings(id: string) {
  const agent = {
    id,
    type: 'claude-code',
    name: 'Existing assistant',
    instructions: 'Existing prompt',
    model: 'provider:model',
    accessible_paths: ['/workspace'],
    allowed_tools: [],
    configuration: {}
  } as AgentEntity
  void AgentModalPopup.show({ agent })
  return render(vi.mocked(TopView.show).mock.calls.at(-1)![0])
}

describe('official assistant prompt settings', () => {
  it('makes the prompt read-only and omits it when saving other settings', async () => {
    openSettings(DEFAULT_OPENCODE_AGENT_ID)
    const prompt = screen.getByDisplayValue('Existing prompt')
    expect(prompt).toHaveAttribute('readonly')
    // Synthetic changes also must not alter the form's persisted instructions.
    fireEvent.change(prompt, { target: { value: 'Attempted override' } })
    fireEvent.change(screen.getByDisplayValue('Existing assistant'), { target: { value: 'Renamed assistant' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }))
    await waitFor(() => expect(mocks.updateAgent).toHaveBeenCalled())
    expect(mocks.updateAgent.mock.calls[0][0]).toMatchObject({
      id: DEFAULT_OPENCODE_AGENT_ID,
      name: 'Renamed assistant',
      model: 'provider:model'
    })
    expect(mocks.updateAgent.mock.calls[0][0]).not.toHaveProperty('instructions')
  })

  it('continues to allow edits to custom agent prompts', async () => {
    openSettings('custom-agent')
    const prompt = screen.getByDisplayValue('Existing prompt')
    expect(prompt).not.toHaveAttribute('readonly')
    fireEvent.change(prompt, { target: { value: 'Custom instructions' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.confirm' }))
    await waitFor(() => expect(mocks.updateAgent).toHaveBeenCalled())
    expect(mocks.updateAgent.mock.calls[0][0]).toMatchObject({
      id: 'custom-agent',
      instructions: 'Custom instructions'
    })
  })
})
