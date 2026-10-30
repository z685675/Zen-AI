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

function openSettings(expand = true) {
  void DefaultAssistantSettingsPopup.show()
  const view = render(vi.mocked(TopView.show).mock.calls.at(-1)![0])
  if (expand) fireEvent.click(screen.getByText('common.advanced_settings'))
  return view
}

function parameterSwitches() {
  return screen
    .getAllByRole('switch')
    .filter((control) => control.getAttribute('aria-label') !== 'models.stream_output')
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
  it('shows the existing default prompt as read-only without rewriting it', () => {
    openSettings(false)
    expect(screen.getByDisplayValue('Keep this prompt')).toHaveAttribute('readonly')
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('collapses advanced controls while identifying existing customized settings', () => {
    openSettings(false)
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByRole('switch', { name: 'models.stream_output' })).toBeChecked()
    expect(screen.getByText('chat.settings.parameters_customized')).toBeInTheDocument()
    expect(mocks.update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('common.advanced_settings'))
    expect(screen.getByRole('switch', { name: 'chat.settings.temperature.label' })).toBeChecked()
  })

  it('preserves disabled streaming when another advanced setting changes', () => {
    openSettings()
    fireEvent.click(screen.getByRole('switch', { name: 'models.stream_output' }))
    fireEvent.click(screen.getByRole('switch', { name: 'chat.settings.temperature.label' }))
    expect(mocks.assistant?.settings?.streamOutput).toBe(false)
    expect(screen.getByRole('switch', { name: 'models.stream_output' })).not.toBeChecked()
  })

  it('resets the visible controls and persisted parameters to the same defaults', () => {
    openSettings()
    expect(parameterSwitches().every((control) => control.getAttribute('aria-checked') === 'true')).toBe(true)

    resetSettings()

    for (const control of parameterSwitches()) {
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

    fireEvent.click(parameterSwitches()[1])

    expect(mocks.assistant?.settings).toEqual({ ...DEFAULT_ASSISTANT_SETTINGS, enableTopP: true })
    expect(parameterSwitches()[0]).not.toBeChecked()
    expect(parameterSwitches()[1]).toBeChecked()
    expect(screen.getByRole('spinbutton')).toHaveValue(DEFAULT_ASSISTANT_SETTINGS.topP.toFixed(2))
  })

  it('uses the default max tokens value when the user enables its limit after resetting and reopening', async () => {
    const view = openSettings()
    resetSettings()

    fireEvent.click(parameterSwitches()[2])
    await waitFor(() =>
      expect(screen.getByRole('spinbutton')).toHaveValue(String(DEFAULT_ASSISTANT_SETTINGS.maxTokens))
    )
    expect(mocks.assistant?.settings).toEqual({ ...DEFAULT_ASSISTANT_SETTINGS, enableMaxTokens: true })

    view.unmount()
    openSettings()

    expect(parameterSwitches()[0]).not.toBeChecked()
    expect(parameterSwitches()[1]).not.toBeChecked()
    expect(parameterSwitches()[2]).toBeChecked()
    expect(screen.getByRole('spinbutton')).toHaveValue(String(DEFAULT_ASSISTANT_SETTINGS.maxTokens))
  })
})
