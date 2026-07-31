import type { ToolQuickPanelApi } from '@renderer/pages/home/Inputbar/types'
import type { Assistant, Model, ThinkingOption } from '@renderer/types'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ThinkingButton from '../ThinkingButton'

const mockOpen = vi.fn()
const mockClose = vi.fn()
const mockUpdateAssistantSettings = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'agent.input.reasoning_effort': 'Thinking Effort',
        'assistants.settings.reasoning_effort.label': 'Reasoning Effort',
        'assistants.settings.reasoning_effort.off': 'Off',
        'assistants.settings.reasoning_effort.low': 'Low',
        'assistants.settings.reasoning_effort.medium': 'Medium',
        'assistants.settings.reasoning_effort.high': 'High',
        'assistants.settings.reasoning_effort.xhigh': 'Extra High'
      })[key] ?? key
  })
}))

vi.mock('@renderer/components/QuickPanel', () => ({
  QuickPanelReservedSymbol: { Thinking: 'thinking' },
  useQuickPanel: () => ({
    open: mockOpen,
    close: mockClose,
    isVisible: false,
    symbol: ''
  })
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({
    assistant: currentAssistant,
    updateAssistantSettings: mockUpdateAssistantSettings
  })
}))

vi.mock('@renderer/components/Buttons', () => ({
  ActionIconButton: ({ children, active, ...props }: any) => (
    <button type="button" data-testid="reasoning-button" data-active={active ? 'true' : undefined} {...props}>
      {children}
    </button>
  )
}))

vi.mock('@renderer/components/Icons/SVGIcon', () => ({
  MdiLightbulbAutoOutline: () => <span data-testid="effort-auto" />,
  MdiLightbulbOffOutline: () => <span data-testid="effort-none" />,
  MdiLightbulbOn: () => <span data-testid="effort-xhigh" />,
  MdiLightbulbOn30: () => <span data-testid="effort-minimal" />,
  MdiLightbulbOn50: () => <span data-testid="effort-low" />,
  MdiLightbulbOn80: () => <span data-testid="effort-medium" />,
  MdiLightbulbOn90: () => <span data-testid="effort-high" />,
  MdiLightbulbQuestion: () => <span data-testid="effort-default" />
}))

vi.mock('antd', () => ({
  Tooltip: ({ children }: any) => children
}))

const model: Model = {
  id: 'gpt-5.6-luna',
  provider: 'openai',
  name: 'GPT-5.6 Luna',
  group: 'openai',
  capabilities: []
}

const createAssistant = (reasoningEffort: ThinkingOption | undefined): Assistant =>
  ({
    id: 'assistant-1',
    name: 'Assistant',
    prompt: '',
    type: 'assistant',
    topics: [],
    tags: [],
    settings: { reasoning_effort: reasoningEffort }
  }) as Assistant

let currentAssistant = createAssistant('medium')

const quickPanel: ToolQuickPanelApi = {
  registerRootMenu: vi.fn(() => vi.fn()),
  registerTrigger: vi.fn(() => vi.fn())
}

const renderChat = (effort: ThinkingOption | undefined = 'medium') => {
  currentAssistant = createAssistant(effort)
  return render(<ThinkingButton quickPanel={quickPanel} model={model} assistantId="assistant-1" variant="chat" />)
}

describe('ThinkingButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentAssistant = createAssistant('medium')
  })

  it('uses medium for legacy default settings and persists the normalized value', () => {
    renderChat('default')

    expect(screen.getByTestId('effort-medium')).toBeInTheDocument()
    expect(mockUpdateAssistantSettings).toHaveBeenCalledWith({
      reasoning_effort: 'medium',
      reasoning_effort_cache: 'medium',
      qwenThinkMode: true
    })
  })

  it('opens the five standardized chat levels in product order', () => {
    renderChat('medium')
    fireEvent.click(screen.getByTestId('reasoning-button'))

    const panel = mockOpen.mock.calls.at(-1)?.[0]
    expect(panel.title).toBe('Reasoning Effort')
    expect(panel.list.map((item: { level: ThinkingOption }) => item.level)).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh'
    ])
  })

  it('stores a selected chat level', async () => {
    renderChat('medium')
    fireEvent.click(screen.getByTestId('reasoning-button'))

    const panel = mockOpen.mock.calls.at(-1)?.[0]
    const highItem = panel.list.find((item: { level: ThinkingOption }) => item.level === 'high')
    await act(async () => highItem.action())

    expect(mockUpdateAssistantSettings).toHaveBeenCalledWith({
      reasoning_effort: 'high',
      reasoning_effort_cache: 'high',
      qwenThinkMode: true
    })
  })

  it('renders the agent control as a visible labeled button with four levels', async () => {
    const onChange = vi.fn()
    render(
      <ThinkingButton
        quickPanel={quickPanel}
        model={model}
        assistantId="assistant-1"
        reasoningEffort="low"
        onReasoningEffortChange={onChange}
        variant="agent"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Thinking Effort: Low' }))
    const panel = mockOpen.mock.calls.at(-1)?.[0]
    expect(panel.list.map((item: { level: ThinkingOption }) => item.level)).toEqual(['low', 'medium', 'high', 'xhigh'])

    const xhighItem = panel.list.find((item: { level: ThinkingOption }) => item.level === 'xhigh')
    await act(async () => xhighItem.action())
    expect(onChange).toHaveBeenCalledWith('xhigh')
  })

  it('uses medium as the agent default when no manual selection exists', () => {
    render(
      <ThinkingButton
        quickPanel={quickPanel}
        model={model}
        assistantId="assistant-1"
        onReasoningEffortChange={vi.fn()}
        variant="agent"
      />
    )

    expect(screen.getByRole('button', { name: 'Thinking Effort: Medium' })).toBeInTheDocument()
    expect(screen.getByTestId('effort-medium')).toBeInTheDocument()
  })
})
