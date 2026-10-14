import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AssistantEnvironmentState, DependencyId } from '../../../services/AssistantEnvironmentService'

const mocks = vi.hoisted(() => ({
  state: {} as AssistantEnvironmentState,
  check: vi.fn(),
  repair: vi.fn(),
  listener: undefined as ((state: AssistantEnvironmentState) => void) | undefined,
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn()
}))
vi.mock('@renderer/context/ThemeProvider', () => ({ useTheme: () => ({ theme: 'light' }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('..', () => {
  const container = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    SettingContainer: container,
    SettingDescription: container,
    SettingDivider: container,
    SettingGroup: container,
    SettingRow: container,
    SettingRowTitle: container,
    SettingTitle: container
  }
})
vi.mock('@renderer/services/AssistantEnvironmentService', () => ({
  AUTO_PREPARED_ASSISTANT_DEPENDENCIES: ['bun', 'uv', 'uvx', 'python'],
  ASSISTANT_DEPENDENCY_I18N_KEYS: Object.fromEntries(
    ['bun', 'uv', 'uvx', 'python', 'pyodide'].map((id) => [id, { name: id, description: `${id}-description` }])
  ),
  ASSISTANT_DEPENDENCY_SOURCE_I18N_KEYS: { app: 'app', system: 'system', network: 'network' },
  getAssistantEnvironmentState: () => mocks.state,
  checkAssistantEnvironmentWithCache: mocks.check,
  repairRequiredAssistantEnvironment: mocks.repair,
  subscribeAssistantEnvironment: (listener: (state: AssistantEnvironmentState) => void) => {
    mocks.listener = listener
    return () => {
      mocks.listener = undefined
    }
  }
}))

import AssistantEnvironmentSettings from '../AssistantEnvironmentSettings'

beforeEach(() => {
  vi.clearAllMocks()
  const dependency = (id: DependencyId) => ({ id, installed: false, source: 'missing' as const })
  mocks.state = {
    preparing: false,
    error: null,
    result: {
      bun: dependency('bun'),
      uv: dependency('uv'),
      uvx: dependency('uvx'),
      python: dependency('python'),
      pyodide: dependency('pyodide'),
      binariesDir: '/owned/tools',
      checkedAt: Date.now()
    }
  }
  mocks.check.mockResolvedValue(mocks.state.result)
  mocks.repair.mockResolvedValue(mocks.state.result)
  vi.stubGlobal('toast', { success: mocks.success, warning: mocks.warning, error: mocks.error })
})

describe('new assistant environment settings', () => {
  it('shows automatic preparation, removes Git and follows background state changes', async () => {
    const view = render(<AssistantEnvironmentSettings />)
    expect(screen.getByText('bun')).toBeInTheDocument()
    expect(screen.queryByText(/Git/)).not.toBeInTheDocument()
    expect(screen.getByText('settings.assistantEnvironment.importRuntime')).toBeInTheDocument()
    act(() => mocks.listener?.({ ...mocks.state, preparing: true }))
    expect(screen.getAllByText('settings.assistantEnvironment.status.preparing')).toHaveLength(4)
    expect(screen.getByRole('button', { name: /settings.assistantEnvironment.prepare$/ })).toBeDisabled()
    act(() => mocks.listener?.({ ...mocks.state, preparing: false }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /settings.assistantEnvironment.prepare$/ })).toBeEnabled()
    )
    view.unmount()
    expect(mocks.listener).toBeUndefined()
  })

  it('does not falsely report successful repair while tools are still missing', async () => {
    render(<AssistantEnvironmentSettings />)
    await waitFor(() => expect(mocks.check).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'settings.assistantEnvironment.prepare' }))
    await waitFor(() => expect(mocks.warning).toHaveBeenCalledWith('settings.assistantEnvironment.prepareIncomplete'))
    expect(mocks.success).not.toHaveBeenCalled()
  })
})
