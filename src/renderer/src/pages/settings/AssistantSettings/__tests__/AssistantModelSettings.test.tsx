import type { Assistant } from '@renderer/types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AssistantModelSettings from '../AssistantModelSettings'

const mocks = vi.hoisted(() => ({
  defaults: {
    temperature: 0.7,
    enableTemperature: false,
    topP: 1,
    enableTopP: false,
    maxTokens: 4096,
    enableMaxTokens: false,
    streamOutput: true,
    toolUseMode: 'function',
    maxToolCalls: 20,
    enableMaxToolCalls: true,
    customParameters: []
  },
  update: vi.fn(),
  selectModel: vi.fn()
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/services/AssistantService', () => ({ DEFAULT_ASSISTANT_SETTINGS: mocks.defaults }))
vi.mock('@renderer/pages/settings', () => ({ SettingRow: ({ children }: any) => <div>{children}</div> }))
vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({ default: () => null }))
vi.mock('@renderer/components/CodeEditor', () => ({ default: () => null }))
vi.mock('@renderer/components/Popups/SelectModelPopup', () => ({ SelectChatModelPopup: { show: mocks.selectModel } }))
vi.mock('@renderer/config/models', () => ({ isEmbeddingModel: () => false, isRerankModel: () => false }))
vi.mock('@renderer/utils', () => ({ modalConfirm: vi.fn().mockResolvedValue(true) }))

function openSettings(settings: Assistant['settings'] = { ...mocks.defaults } as Assistant['settings']) {
  function Harness() {
    const [assistant, setAssistant] = useState<Assistant>({
      id: 'existing-custom-role',
      name: 'My role',
      prompt: 'Keep my instructions',
      topics: [],
      type: 'assistant',
      settings
    })
    return (
      <AssistantModelSettings
        assistant={assistant}
        updateAssistant={setAssistant}
        updateAssistantSettings={(next) => {
          mocks.update(next)
          setAssistant((current) => ({ ...current, settings: { ...current.settings, ...next } }))
        }}
      />
    )
  }
  return render(<Harness />)
}

beforeEach(() => {
  vi.clearAllMocks()
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

describe('chat model advanced settings', () => {
  it('shows only model selection and streaming before expanding advanced settings', () => {
    openSettings()
    expect(screen.getByText('assistants.settings.default_model')).toBeVisible()
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByRole('switch', { name: 'models.stream_output' })).toBeChecked()
    expect(screen.getByText('chat.settings.parameters_default')).toBeVisible()
    expect(screen.queryByText('chat.settings.temperature.label')).not.toBeInTheDocument()
  })

  it('keeps old role overrides visible in the status and resets custom parameters together', () => {
    openSettings({
      ...mocks.defaults,
      enableTemperature: true,
      temperature: 0.3,
      enableTopP: true,
      customParameters: [{ name: 'temperature', type: 'number', value: 0.9 }]
    } as Assistant['settings'])
    expect(screen.getByText('chat.settings.parameters_customized')).toBeVisible()
    expect(mocks.update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('common.advanced_settings'))
    expect(screen.getByRole('switch', { name: 'chat.settings.temperature.label' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'chat.settings.reset' }))
    expect(mocks.update).toHaveBeenLastCalledWith(mocks.defaults)
    expect(screen.getByRole('switch', { name: 'chat.settings.temperature.label' })).not.toBeChecked()
    expect(screen.getByText('chat.settings.parameters_default')).toBeVisible()
    expect(screen.queryByDisplayValue('temperature')).not.toBeInTheDocument()
  })

  it('makes sampling opt-ins exclusive and preserves them when streaming changes', () => {
    openSettings()
    fireEvent.click(screen.getByText('common.advanced_settings'))
    fireEvent.click(screen.getByRole('switch', { name: 'chat.settings.temperature.label' }))
    fireEvent.click(screen.getByRole('switch', { name: 'chat.settings.top_p.label' }))
    expect(screen.getByRole('switch', { name: 'chat.settings.temperature.label' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'chat.settings.top_p.label' })).toBeChecked()
    fireEvent.click(screen.getByRole('switch', { name: 'models.stream_output' }))
    expect(mocks.update).toHaveBeenLastCalledWith({ streamOutput: false })
    expect(screen.getByRole('switch', { name: 'chat.settings.top_p.label' })).toBeChecked()
  })

  it('does not silently rewrite temperature when selecting a model', async () => {
    mocks.selectModel.mockResolvedValue({ id: 'kimi-k2', name: 'kimi-k2', provider: 'test', group: 'test' })
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: 'assistants.presets.edit.model.select.title' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'kimi-k2' })).toBeVisible())
    expect(mocks.update).not.toHaveBeenCalled()
  })
})
