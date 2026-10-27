import type { GetAgentResponse } from '@renderer/types'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import PermissionModeSettings from '../PermissionModeSettings'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }))
vi.mock('../../shared', () => ({
  defaultConfiguration: { permission_mode: 'default', max_turns: 100, env_vars: {} },
  SettingsContainer: ({ children }: any) => <div>{children}</div>,
  SettingsItem: ({ children }: any) => <div>{children}</div>,
  SettingsTitle: ({ children }: any) => <h2>{children}</h2>
}))
afterEach(cleanup)

describe('native mode settings', () => {
  it('renders two accessible options and maps old Full Auto to Build', () => {
    const base = { id: 'agent', configuration: { permission_mode: 'bypassPermissions' } } as GetAgentResponse
    render(<PermissionModeSettings agentBase={base} update={vi.fn()} />)
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.getByRole('button', { name: /^Build/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /^Plan/ })).toHaveAttribute('aria-pressed', 'false')
  })
  it('saves only the selected entity configuration, without legacy tool preapproval or soul side effects', async () => {
    const configuration = {
      permission_mode: 'bypassPermissions',
      max_turns: 100,
      env_vars: {},
      reasoning_effort: 'high',
      soul_enabled: true,
      future_option: 'preserved'
    }
    const base = { id: 'session', configuration, allowed_tools: ['custom-tool'] } as GetAgentResponse
    const update = vi.fn().mockResolvedValue(undefined)
    render(<PermissionModeSettings agentBase={base} update={update} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Plan/ })))
    expect(update).toHaveBeenCalledExactlyOnceWith({
      id: 'session',
      configuration: { ...configuration, permission_mode: 'plan' }
    })
  })
  it('does not save when selecting the active Build option', () => {
    const base = { id: 'agent', configuration: { permission_mode: 'default' } } as GetAgentResponse
    const update = vi.fn()
    render(<PermissionModeSettings agentBase={base} update={update} />)
    fireEvent.click(screen.getByRole('button', { name: /^Build/ }))
    expect(update).not.toHaveBeenCalled()
  })
})
