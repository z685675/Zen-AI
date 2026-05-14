import type { KnowledgeBase, Model } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AdvancedSettingsPanel from '../components/KnowledgeSettings/AdvancedSettingsPanel'

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  handlers: {
    handleChunkSizeChange: vi.fn(),
    handleChunkOverlapChange: vi.fn(),
    handleThresholdChange: vi.fn(),
    handleDocPreprocessChange: vi.fn(),
    handleRerankModelChange: vi.fn()
  }
}))

vi.mock('@renderer/components/TooltipIcons', () => ({
  InfoTooltip: ({ title }: { title: string }) => <div data-testid="tooltip">{title}</div>
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t })
}))

vi.mock('lucide-react', () => ({
  TriangleAlert: () => <span>warning</span>
}))

vi.mock('antd', () => ({
  Alert: ({ message }: { message: string }) => <div role="alert">{message}</div>,
  InputNumber: ({ value, onChange, placeholder, 'aria-label': ariaLabel }: any) => (
    <input
      type="number"
      data-testid={String(ariaLabel)}
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.valueAsNumber)}
    />
  ),
  Select: ({ value, onChange, options, placeholder }: any) => (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} data-testid="doc-preprocess-select">
      <option value="">{placeholder}</option>
      {options?.map((opt: any) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}))

vi.mock('@renderer/components/ModelSelector', () => ({
  default: ({ value, onChange, placeholder }: any) => (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} data-testid="model-selector">
      <option value="">{placeholder}</option>
      <option value="rerank-model">rerank-model</option>
    </select>
  )
}))

vi.mock('@renderer/hooks/useProvider', () => ({
  useProviders: () => ({ providers: [] })
}))

vi.mock('@renderer/services/ModelService', () => ({
  getModelUniqId: (model: any) => model?.id || ''
}))

vi.mock('@renderer/config/models', () => ({
  isRerankModel: () => true
}))

function createKnowledgeBase(overrides: Partial<KnowledgeBase> = {}): KnowledgeBase {
  return {
    id: '1',
    name: 'Test KB',
    model: { id: 'test-model', provider: 'test-provider', name: 'Test Model', group: 'test' } as Model,
    items: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    version: 1,
    chunkSize: 500,
    chunkOverlap: 200,
    threshold: 0.5,
    ...overrides
  }
}

describe('AdvancedSettingsPanel', () => {
  const mockBase = createKnowledgeBase()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('matches snapshot', () => {
    const { container } = render(
      <AdvancedSettingsPanel newBase={mockBase} handlers={mocks.handlers} docPreprocessSelectOptions={[]} />
    )

    expect(container.firstChild).toMatchSnapshot()
  })

  it('calls handlers when settings change', () => {
    render(<AdvancedSettingsPanel newBase={mockBase} handlers={mocks.handlers} docPreprocessSelectOptions={[]} />)

    fireEvent.change(screen.getByTestId('knowledge.chunk_size'), { target: { value: '600' } })
    expect(mocks.handlers.handleChunkSizeChange).toHaveBeenCalledWith(600)

    fireEvent.change(screen.getByTestId('knowledge.chunk_overlap'), { target: { value: '300' } })
    expect(mocks.handlers.handleChunkOverlapChange).toHaveBeenCalledWith(300)

    fireEvent.change(screen.getByTestId('knowledge.threshold'), { target: { value: '0.6' } })
    expect(mocks.handlers.handleThresholdChange).toHaveBeenCalledWith(0.6)
  })
})
