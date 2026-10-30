import type { Assistant } from '@renderer/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AssistantPromptSettings from '../AssistantPromptSettings'

vi.mock('emoji-picker-element', () => ({}))
vi.mock('@renderer/components/EmojiPicker', () => ({ default: () => null }))
vi.mock('@renderer/components/CodeEditor', () => ({
  default: ({
    value,
    onChange,
    readOnly
  }: {
    value: string
    onChange?: (value: string) => void
    readOnly?: boolean
  }) => <textarea value={value} readOnly={readOnly} onChange={(event) => onChange?.(event.target.value)} />
}))
vi.mock('@renderer/hooks/usePromptProcessor', () => ({
  usePromptProcessor: ({ prompt }: { prompt: string }) => prompt
}))
vi.mock('@renderer/services/TokenService', () => ({ estimateTextTokens: () => 1 }))
vi.mock('@renderer/utils', () => ({ getLeadingEmoji: () => '' }))
vi.mock('@renderer/pages/settings', () => ({ SettingDivider: () => null }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

beforeEach(() => {
  vi.stubGlobal('toast', { success: vi.fn() })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('conversation prompt editing', () => {
  const assistant = { id: 'default', name: 'Existing name', prompt: 'Existing prompt' } as Assistant

  it('keeps the default prompt read-only even after a double click or renaming', () => {
    const update = vi.fn()
    render(<AssistantPromptSettings assistant={assistant} updateAssistant={update} />)
    expect(screen.queryByRole('button', { name: 'common.edit' })).not.toBeInTheDocument()
    fireEvent.doubleClick(screen.getByText('Existing prompt'))
    expect(document.querySelector('textarea')).toBeNull()
    const name = screen.getByDisplayValue('Existing name')
    fireEvent.change(name, { target: { value: 'Renamed' } })
    fireEvent.blur(name)
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Renamed', prompt: 'Existing prompt' }))
  })

  it('lets a custom role edit and save its own prompt', () => {
    const update = vi.fn()
    render(<AssistantPromptSettings assistant={{ ...assistant, id: 'custom-role' }} updateAssistant={update} />)
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }))
    const prompt = screen.getByDisplayValue('Existing prompt')
    expect(prompt).not.toHaveAttribute('readonly')
    fireEvent.change(prompt, { target: { value: 'Custom prompt' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'custom-role', prompt: 'Custom prompt' }))
  })
})
