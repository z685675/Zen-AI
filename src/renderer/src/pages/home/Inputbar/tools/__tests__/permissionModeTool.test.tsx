import { permissionModeCards } from '@renderer/config/agent'
import type { ToolContext } from '@renderer/pages/home/Inputbar/types'
import { normalizePermissionMode } from '@renderer/types'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import permissionModeTool from '../permissionModeTool'

const mocks = vi.hoisted(() => ({ update: vi.fn(), session: { current: undefined as any } }))
vi.mock('@renderer/hooks/agents/useActiveSession', () => ({
  useActiveSession: () => ({ session: mocks.session.current })
}))
vi.mock('@renderer/hooks/agents/useUpdateSession', () => ({
  useUpdateSession: () => ({ updateSession: mocks.update })
}))
vi.mock('antd', () => ({ Tooltip: ({ children, title }: any) => <span title={title}>{children}</span> }))
vi.mock('../../types', () => ({
  defineTool: (tool: unknown) => tool,
  registerTool: vi.fn(),
  TopicType: { Session: 'session' }
}))

const ModeButtons = permissionModeTool.render!
const context = {
  t: (_key: string, fallback: string) => fallback,
  session: { agentId: 'zen-opencode-default', sessionId: 'test-session' }
} as unknown as ToolContext & { t: any }

beforeEach(() => {
  mocks.update.mockReset().mockResolvedValue(undefined)
  mocks.session.current = {
    id: 'test-session',
    configuration: { permission_mode: 'default', max_turns: 100 },
    allowed_tools: ['legacy-tool']
  }
})
afterEach(cleanup)

describe('native Plan / Build mode buttons', () => {
  it.each(['default', 'acceptEdits', 'bypassPermissions'] as const)('shows only Plan and Build for %s', (stored) => {
    mocks.session.current.configuration.permission_mode = stored
    render(<ModeButtons {...context} />)
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Build' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute('aria-pressed', 'false')
    expect(normalizePermissionMode(stored)).toBe('acceptEdits')
    expect(permissionModeCards.map((card) => card.titleFallback)).toEqual(['Plan', 'Build'])
  })
  it('changes only this session mode, preserving configuration and legacy tool lists', async () => {
    render(<ModeButtons {...context} />)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Plan' })))
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(
      { id: 'test-session', configuration: { permission_mode: 'plan', max_turns: 100, env_vars: {} } },
      { showSuccessToast: false }
    )
    expect(mocks.session.current.allowed_tools).toEqual(['legacy-tool'])
  })
  it('selects Build from Plan and does not save when clicking the active mode', async () => {
    mocks.session.current.configuration.permission_mode = 'plan'
    render(<ModeButtons {...context} />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    expect(mocks.update).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Build' })))
    expect(mocks.update.mock.calls[0][0].configuration.permission_mode).toBe('acceptEdits')
  })
  it('disables both buttons while saving and explains both modes', async () => {
    mocks.update.mockReturnValue(new Promise(() => {}))
    render(<ModeButtons {...context} />)
    fireEvent.click(screen.getByRole('button', { name: 'Plan' }))
    expect(screen.getByRole('button', { name: 'Plan' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Build' })).toBeDisabled()
    expect(screen.getByTitle(/不修改用户文件/)).toBeInTheDocument()
    expect(screen.getByTitle(/覆盖原文件/)).toBeInTheDocument()
  })
})
