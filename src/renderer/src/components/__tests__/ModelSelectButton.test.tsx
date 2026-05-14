import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'button.select_model': '选择模型'
      }
      return translations[key] || key
    }
  })
}))

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: ({ model }: { model?: { name?: string } }) => <div>{model?.name || 'No Model'}</div>
}))

const { showMock } = vi.hoisted(() => ({
  showMock: vi.fn()
}))

vi.mock('@renderer/components/Popups/SelectModelPopup', () => ({
  SelectChatModelPopup: {
    show: showMock
  }
}))

import ModelSelectButton from '../ModelSelectButton'

describe('ModelSelectButton', () => {
  it('renders safely when model is undefined', () => {
    render(<ModelSelectButton model={undefined} onSelectModel={vi.fn()} />)

    expect(screen.getByRole('button')).toBeInTheDocument()
    expect(screen.getByText('No Model')).toBeInTheDocument()
  })

  it('still opens the model picker when no model is selected', async () => {
    const user = userEvent.setup()
    const onSelectModel = vi.fn()

    showMock.mockResolvedValueOnce(undefined)

    render(<ModelSelectButton model={undefined} onSelectModel={onSelectModel} />)

    await user.click(screen.getByRole('button'))

    expect(showMock).toHaveBeenCalledWith({ model: undefined, filter: undefined })
    expect(onSelectModel).not.toHaveBeenCalled()
  })
})
