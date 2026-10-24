import { TopView } from '@renderer/components/TopView'
import { DEFAULT_ASSISTANT_SETTINGS } from '@renderer/services/AssistantService'
import type { Assistant } from '@renderer/types'
import { modalConfirm } from '@renderer/utils'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import DefaultAssistantSettingsPopup from '../DefaultAssistantSettings'

const mocks = vi.hoisted(() => ({
  assistant: undefined as Assistant | undefined,
  update: vi.fn()
}))

vi.mock('@renderer/components/TopView', () => ({ TopView: { show: vi.fn(), hide: vi.fn() } }))
vi.mock('@renderer/components/EmojiPicker', () => ({ default: () => null }))
vi.mock('@renderer/context/ThemeProvider', () => ({ useTheme: () => ({ theme: 'light' }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/i18n', () => ({ default: { t: (key: string) => key } }))
vi.mock('@renderer/utils', () => ({ getLeadingEmoji: () => '', modalConfirm: vi.fn().mockResolvedValue(true) }))
vi.mock('@renderer/hooks/useAssistant', () => ({
  useDefaultAssistant: () => {
    const [defaultAssistant, setDefaultAssistant] = useState(mocks.assistant)
    return {
      defaultAssistant,
      updateDefaultAssistant: (assistant: Assistant) => {
        mocks.assistant = assistant
        mocks.update(assistant)
        setDefaultAssistant(assistant)
      }
    }
  }
}))

// Keep the real default settings template while isolating unrelated service dependencies.
vi.mock('@renderer/store', () => ({ default: {} }))
vi.mock('@renderer/store/assistants', () => ({
  addAssistant: vi.fn(),
  addQuickAssistantId: vi.fn(),
  removeQuickAssistantId: vi.fn()
}))
vi.mock('@renderer/hooks/useStore', () => ({ getStoreProviders: vi.fn() }))
vi.mock('@renderer/config/models', () => ({ getModelSupportedReasoningEffortOptions: vi.fn() }))
vi.mock('@renderer/config/models/qwen', () => ({ isQwenMTModel: vi.fn() }))
vi.mock('@renderer/services/ModelRequestRecovery', () => ({ resolveNextManagedRequestModel: vi.fn() }))

function openSettings() {
  void DefaultAssistantSettingsPopup.show()
  return render(vi.mocked(TopView.show).mock.calls.at(-1)![0])
}

function resetSettings() {
  fireEvent.click(within(screen.getByText('settings.assistant.model_params')).getByRole('button'))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(modalConfirm).mockResolvedValue(true)
  mocks.assistant = {
    id: 'default',
    name: 'Custom assistant',
    prompt: 'Keep this prompt',
    emoji: '',
    topics: [],
    type: 'assistant',
    settings: {
      ...DEFAULT_ASSISTANT_SETTINGS,
      temperature: 0.3,
      enableTemperature: true,
      topP: 0.6,
      enableTopP: true,
      maxTokens: 12000,
      enableMaxTokens: true,
      toolUseMode: 'prompt'
    }
  }
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

describe('default assistant settings reset', () => {
  it('resets the visible controls and persisted parameters to the same defaults', () => {
    openSettings()
    expect(screen.getAllByRole('switch').every((control) => control.getAttribute('aria-checked') === 'true')).toBe(true)

    resetSettings()

    for (const control of screen.getAllByRole('switch')) {
      expect(control).not.toBeChecked()
    }
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
    expect(screen.getByText('assistants.settings.tool_use_mode.function')).toBeInTheDocument()
    expect(mocks.update).toHaveBeenLastCalledWith({
      ...mocks.assistant,
      name: 'Custom assistant',
      prompt: 'Keep this prompt',
      settings: DEFAULT_ASSISTANT_SETTINGS
    })
  })

  it('does not re-enable temperature or replace max tokens with zero when another setting changes after reset', () => {
    openSettings()
    resetSettings()

    fireEvent.click(screen.getAllByRole('switch')[1])

    expect(mocks.assistant?.settings).toEqual({ ...DEFAULT_ASSISTANT_SETTINGS, enableTopP: true })
    expect(screen.getAllByRole('switch')[0]).not.toBeChecked()
    expect(screen.getAllByRole('switch')[1]).toBeChecked()
    expect(screen.getByRole('spinbutton')).toHaveValue(DEFAULT_ASSISTANT_SETTINGS.topP.toFixed(2))
  })

  it('uses the default max tokens value when the user enables its limit after resetting and reopening', async () => {
    const view = openSettings()
    resetSettings()

    fireEvent.click(screen.getAllByRole('switch')[2])
    await waitFor(() =>
      expect(screen.getByRole('spinbutton')).toHaveValue(String(DEFAULT_ASSISTANT_SETTINGS.maxTokens))
    )
    expect(mocks.assistant?.settings).toEqual({ ...DEFAULT_ASSISTANT_SETTINGS, enableMaxTokens: true })

    view.unmount()
    openSettings()

    expect(screen.getAllByRole('switch')[0]).not.toBeChecked()
    expect(screen.getAllByRole('switch')[1]).not.toBeChecked()
    expect(screen.getAllByRole('switch')[2]).toBeChecked()
    expect(screen.getByRole('spinbutton')).toHaveValue(String(DEFAULT_ASSISTANT_SETTINGS.maxTokens))
  })
})
