import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import InputEmbeddingDimension from '../InputEmbeddingDimension'

const mocks = vi.hoisted(() => ({
  getEmbeddingDimensions: vi.fn(),
  t: vi.fn((key: string) => {
    const translations: Record<string, string> = {
      'knowledge.embedding_model_required': 'Embedding model required',
      'knowledge.provider_not_found': 'Provider not found',
      'message.error.get_embedding_dimensions': 'Failed to get embedding dimensions',
      'knowledge.dimensions_size_placeholder': 'Enter dimensions',
      'knowledge.dimensions_auto_set': 'Auto set dimensions',
      'common.get_embedding_dimension': 'Get Embedding Dimension'
    }
    return translations[key] ?? key
  })
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({ llm: { settings: {} } })
  }
}))

vi.mock('antd', () => {
  const Compact: React.FC<React.PropsWithChildren<{ style?: React.CSSProperties }>> = ({ children, style }) => (
    <div data-testid="space-compact" style={style}>
      {children}
    </div>
  )

  const InputNumber = React.forwardRef<HTMLInputElement, any>(function MockInputNumber(props, ref) {
    const { value, onChange, placeholder, disabled, style } = props
    return (
      <input
        ref={ref}
        data-testid="input-number"
        type="number"
        value={value ?? ''}
        placeholder={placeholder}
        disabled={disabled}
        style={style}
        onChange={(event) => onChange?.(event.currentTarget.value === '' ? null : Number(event.currentTarget.value))}
      />
    )
  })

  const Button: React.FC<any> = ({ children, icon, ...props }) => (
    <button type="button" {...props}>
      {icon}
      {children}
    </button>
  )

  const Tooltip: React.FC<React.PropsWithChildren<{ title: string }>> = ({ children, title }) => (
    <div data-testid="tooltip" data-title={title}>
      {children}
    </div>
  )

  return {
    Button,
    InputNumber,
    Space: { Compact },
    Tooltip
  }
})

vi.mock('@renderer/aiCore', () => ({
  AiProvider: vi.fn().mockImplementation(() => ({
    getEmbeddingDimensions: mocks.getEmbeddingDimensions
  }))
}))

vi.mock('@renderer/hooks/useProvider', () => ({
  useProvider: vi.fn(() => ({
    provider: { id: 'test-provider', name: 'Test Provider' }
  }))
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t }),
  initReactI18next: { type: '3rdParty', init: vi.fn() }
}))

vi.mock('@renderer/components/Icons', () => ({
  RefreshIcon: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="refresh-icon" {...props} />
}))

Object.assign(window, {
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
})

describe('InputEmbeddingDimension', () => {
  const mockModel = {
    id: 'test-model',
    name: 'Test Model',
    provider: 'test-provider',
    group: 'default'
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders enabled controls when a model is provided', () => {
    render(<InputEmbeddingDimension model={mockModel} value={1536} />)

    expect(screen.getByPlaceholderText('Enter dimensions')).not.toBeDisabled()
    expect(screen.getByRole('button', { name: 'Get Embedding Dimension' })).not.toBeDisabled()
  })

  it('calls onChange when the input value changes', () => {
    const onChange = vi.fn()

    render(<InputEmbeddingDimension model={mockModel} onChange={onChange} />)

    fireEvent.change(screen.getByPlaceholderText('Enter dimensions'), { target: { value: '2048' } })

    expect(onChange).toHaveBeenCalledWith(2048)
  })

  it('fetches dimensions and forwards them to onChange', async () => {
    mocks.getEmbeddingDimensions.mockResolvedValue(1024)
    const onChange = vi.fn()

    render(<InputEmbeddingDimension model={mockModel} onChange={onChange} />)

    await userEvent.click(screen.getByRole('button', { name: 'Get Embedding Dimension' }))

    await waitFor(() => {
      expect(mocks.getEmbeddingDimensions).toHaveBeenCalledWith(mockModel)
      expect(onChange).toHaveBeenCalledWith(1024)
    })
  })

  it('disables controls when no model is available', () => {
    render(<InputEmbeddingDimension />)

    expect(screen.getByPlaceholderText('Enter dimensions')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Get Embedding Dimension' })).toBeDisabled()
  })

  it('shows an error toast when fetching fails', async () => {
    mocks.getEmbeddingDimensions.mockRejectedValue(new Error('API Error'))

    render(<InputEmbeddingDimension model={mockModel} />)

    await userEvent.click(screen.getByRole('button', { name: 'Get Embedding Dimension' }))

    await waitFor(() => {
      expect(window.toast.error).toHaveBeenCalledWith('Failed to get embedding dimensions\nAPI Error')
    })
  })
})
