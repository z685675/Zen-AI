import type { KnowledgeBase, Model } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import GeneralSettingsPanel from '../components/KnowledgeSettings/GeneralSettingsPanel'

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      models: [
        {
          id: 'text-embedding-3-small',
          provider: 'openai',
          name: 'text-embedding-3-small',
          group: 'embedding'
        }
      ]
    }
  ],
  handlers: {
    handleEmbeddingModelChange: vi.fn(),
    handleDimensionChange: vi.fn()
  }
}))

vi.mock('@renderer/components/TooltipIcons', () => ({
  InfoTooltip: ({ title, placement }: { title: string; placement: string }) => (
    <span data-testid="info-tooltip" title={title} data-placement={placement}>
      i
    </span>
  )
}))

vi.mock('@renderer/components/ModelSelector', () => ({
  default: ({ value, onChange, placeholder, allowClear, providers }: any) => {
    const hasProviders = providers && providers.length > 0

    return (
      <select
        data-testid="model-selector"
        value={value || ''}
        onChange={(e) => onChange?.(e.target.value)}
        data-placeholder={placeholder}
        data-allow-clear={allowClear}
        data-has-providers={hasProviders}>
        <option value="">Select model</option>
        <option value="openai/text-embedding-3-small">text-embedding-3-small</option>
        <option value="openai/text-embedding-ada-002">text-embedding-ada-002</option>
      </select>
    )
  }
}))

vi.mock('@renderer/components/InputEmbeddingDimension', () => ({
  default: ({ value, onChange, model, disabled }: any) => (
    <input
      data-testid="embedding-dimension-input"
      type="number"
      value={value || ''}
      onChange={(e) => onChange?.(Number(e.target.value))}
      disabled={disabled}
      data-model={model?.id}
    />
  )
}))

vi.mock('@renderer/hooks/useProvider', () => ({
  useProviders: () => ({ providers: mocks.providers })
}))

vi.mock('@renderer/services/ModelService', () => ({
  getModelUniqId: (model: Model | undefined) => (model ? `${model.provider}/${model.id}` : undefined)
}))

vi.mock('@renderer/config/models', () => ({
  isEmbeddingModel: (model: Model) => model.group === 'embedding'
}))

vi.mock('@renderer/config/constant', () => ({
  DEFAULT_KNOWLEDGE_DOCUMENT_COUNT: 6
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t })
}))

vi.mock('antd', () => ({
  Input: ({ value, onChange, placeholder }: any) => (
    <input data-testid="name-input" value={value} onChange={onChange} placeholder={placeholder} />
  ),
  Slider: ({ value, onChange, min, max, step, marks, style }: any) => (
    <input
      data-testid="document-count-slider"
      type="range"
      value={value}
      onChange={(e) => onChange?.(Number(e.target.value))}
      min={min}
      max={max}
      step={step}
      style={style}
      data-marks={JSON.stringify(marks)}
    />
  )
}))

function createKnowledgeBase(overrides: Partial<KnowledgeBase> = {}): KnowledgeBase {
  const defaultModel: Model = {
    id: 'text-embedding-3-small',
    provider: 'openai',
    name: 'text-embedding-3-small',
    group: 'embedding'
  }

  return {
    id: 'test-base-id',
    name: 'Test Knowledge Base',
    model: defaultModel,
    items: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    version: 1,
    ...overrides
  }
}

describe('GeneralSettingsPanel', () => {
  const mockBase = createKnowledgeBase()
  const mockSetNewBase = vi.fn()

  const renderComponent = (props: Partial<any> = {}) => {
    return render(
      <GeneralSettingsPanel newBase={mockBase} setNewBase={mockSetNewBase} handlers={mocks.handlers} {...props} />
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('matches snapshot', () => {
    const { container } = renderComponent()
    expect(container.firstChild).toMatchSnapshot()
  })

  it('handles name, model, dimension and document count changes', async () => {
    const user = userEvent.setup()
    renderComponent()

    await user.type(screen.getByTestId('name-input'), 'New Knowledge Base Name')
    expect(mockSetNewBase).toHaveBeenCalledWith(expect.any(Function))

    await user.selectOptions(screen.getByTestId('model-selector'), 'openai/text-embedding-ada-002')
    expect(mocks.handlers.handleEmbeddingModelChange).toHaveBeenCalledWith('openai/text-embedding-ada-002')

    fireEvent.change(screen.getByTestId('embedding-dimension-input'), { target: { value: '1536' } })
    expect(mocks.handlers.handleDimensionChange).toHaveBeenCalledWith(1536)

    fireEvent.change(screen.getByTestId('document-count-slider'), { target: { value: '10' } })
    expect(mockSetNewBase).toHaveBeenCalledWith(expect.any(Function))
  })

  it('disables dimension input when no model is selected', () => {
    const baseWithoutModel = createKnowledgeBase({ model: undefined as any })
    renderComponent({ newBase: baseWithoutModel })
    expect(screen.getByTestId('embedding-dimension-input')).toBeDisabled()
  })
})
