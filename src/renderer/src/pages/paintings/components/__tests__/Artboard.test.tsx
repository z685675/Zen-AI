import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import Artboard from '../Artboard'

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn()
  },
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'common.cancel': 'Cancel',
        'common.copy': 'Copy',
        'message.copy.success': 'Copied',
        'message.copy.failed': 'Copy failed',
        'paintings.copy_prompt': 'Copy prompt',
        'paintings.created_at': 'Created at',
        'paintings.image_placeholder': 'No image',
        'paintings.prompt_used': 'Prompt used'
      }
      return translations[key] || key
    }
  })
}))

const mockToast = {
  success: vi.fn(),
  error: vi.fn()
}

const mockWriteText = vi.fn()

function createImageFile(id: string, createdAt: string) {
  return {
    id,
    name: `${id}.png`,
    origin_name: `${id}.png`,
    path: `${id}.png`,
    size: 1024,
    ext: '.png',
    type: 'image',
    count: 1,
    created_at: createdAt
  } as any
}

function renderArtboard({
  prompt,
  files = [],
  currentImageIndex = 0,
  isLoading = false
}: {
  prompt?: string
  files?: any[]
  currentImageIndex?: number
  isLoading?: boolean
} = {}) {
  return render(
    <Artboard
      painting={{ id: 'painting-1', files, urls: [], prompt }}
      isLoading={isLoading}
      currentImageIndex={currentImageIndex}
      onPrevImage={vi.fn()}
      onNextImage={vi.fn()}
      onCancel={vi.fn()}
      imageCover={<div>cover</div>}
      prompt={prompt}
    />
  )
}

describe('Artboard prompt popover', () => {
  beforeEach(() => {
    Object.assign(window, { toast: mockToast })
    Object.assign(navigator, { clipboard: { writeText: mockWriteText } })
    mockWriteText.mockResolvedValue(undefined)
    vi.clearAllMocks()
  })

  it('renders the prompt trigger when a prompt is provided', () => {
    renderArtboard({ prompt: 'A warm watercolor lobster assistant' })

    expect(screen.getByText('Prompt used')).toBeInTheDocument()
    expect(screen.getByText('A warm watercolor lobster assistant')).toBeInTheDocument()
  })

  it('does not render the prompt trigger for an empty prompt', () => {
    renderArtboard({ prompt: '   ' })

    expect(screen.queryByText('Prompt used')).not.toBeInTheDocument()
  })

  it('copies the prompt text from the prompt popover', async () => {
    const prompt = 'cinematic product photo, soft daylight'
    renderArtboard({ prompt })

    await userEvent.click(screen.getByRole('button', { name: /Prompt used/i }))
    await userEvent.click(await screen.findByRole('button', { name: 'Copy prompt' }))

    expect(mockWriteText).toHaveBeenCalledWith(prompt)
    expect(mockToast.success).toHaveBeenCalledWith('Copied')
  })

  it('shows the full prompt in an upward popover when clicked', async () => {
    const prompt = 'A long image prompt that should be shown in the prompt popover'
    renderArtboard({ prompt })

    await userEvent.click(screen.getByRole('button', { name: /Prompt used/i }))

    expect(await screen.findByRole('button', { name: 'Copy prompt' })).toBeInTheDocument()
    expect(screen.getAllByText(prompt)).toHaveLength(2)
  })

  it('shows the created time for the current generated image file', () => {
    renderArtboard({
      prompt: 'image prompt',
      files: [
        createImageFile('first-image', '2026-06-01T09:10:00'),
        createImageFile('second-image', '2026-06-01T10:20:00')
      ],
      currentImageIndex: 1
    })

    expect(screen.getByText('Created at 2026/06/01 10:20:00')).toBeInTheDocument()
  })

  it('does not show created time without a generated image file', () => {
    renderArtboard({ prompt: 'image prompt', isLoading: true })

    expect(screen.queryByText(/Created at/)).not.toBeInTheDocument()
  })
})
