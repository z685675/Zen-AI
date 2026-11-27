import type { AgentEntity } from '@renderer/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AgentChatNavbar from './index'

const mocks = vi.hoisted(() => ({ search: vi.fn(), shortcut: vi.fn() }))
vi.mock('@renderer/components/app/Navbar', () => ({ NavbarHeader: ({ children }: any) => <header>{children}</header> }))
vi.mock('@renderer/components/NavbarIcon', () => ({ default: (props: any) => <button type="button" {...props} /> }))
vi.mock('@renderer/components/Popups/AgentSearchPopup', () => ({ default: { show: mocks.search } }))
vi.mock('@renderer/context/AgentWorkspaceProvider', () => ({ useAgentWorkspace: () => 'opencode' }))
vi.mock('@renderer/hooks/useShortcuts', () => ({ useShortcut: mocks.shortcut }))
vi.mock('@renderer/hooks/useSettings', () => ({ useEnableDeveloperMode: () => ({ enableDeveloperMode: false }) }))
vi.mock('@renderer/hooks/agents/useAgents', () => ({ useAgents: () => ({ agents: [] }) }))
vi.mock('@renderer/hooks/agents/useActiveAgent', () => ({ useActiveAgent: () => ({ setActiveAgentId: vi.fn() }) }))
vi.mock('@renderer/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('antd', () => ({ Tooltip: ({ children }: any) => children }))
vi.mock('./AgentContent', () => ({ default: () => <span>智能助手 · 任务名称 · 成果</span> }))
afterEach(cleanup)

describe('assistant header branding', () => {
  it('keeps the session title and search in the shared title bar', () => {
    render(<AgentChatNavbar activeAgent={{ id: 'zen-opencode-default' } as AgentEntity} />)
    expect(screen.queryByText('OpenCode')).not.toBeInTheDocument()
    expect(screen.getByText('智能助手 · 任务名称 · 成果')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'agent.session.search.placeholder' }))
    expect(mocks.search).toHaveBeenCalledWith('opencode')
  })
})
