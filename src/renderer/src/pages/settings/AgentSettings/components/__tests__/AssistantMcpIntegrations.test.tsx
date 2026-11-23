import type { GetAgentSessionResponse, MCPServer } from '@renderer/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ mcpServers: [] as MCPServer[] }))
vi.mock('@renderer/hooks/useMCPServers', () => ({ useMCPServers: () => mocks }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

import AssistantMcpIntegrations from '../AssistantMcpIntegrations'

describe('assistant MCP setup', () => {
  it('keeps services opt-in, probes explicitly and saves only the selected connection', async () => {
    mocks.mcpServers = [
      { id: 'curated', name: '@cherry/dify-knowledge', type: 'inMemory', isActive: true },
      { id: 'other', name: 'Untrusted server', type: 'stdio', command: 'fixture', isActive: true }
    ]
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }))
    })
    const probeMcp = vi.fn().mockResolvedValue(['search_knowledge'])
    Object.assign(window.api, { agentLifecycle: { probeMcp } })
    const update = vi.fn().mockResolvedValue(undefined)
    const onManage = vi.fn()
    const session = { id: 'session', configuration: { permission_mode: 'acceptEdits' } } as GetAgentSessionResponse
    render(<AssistantMcpIntegrations session={session} update={update} onManage={onManage} />)
    expect(screen.queryByText('Untrusted server')).not.toBeInTheDocument()
    const toggle = screen.getByRole('switch', { name: '@cherry/dify-knowledge' })
    expect(toggle).not.toBeChecked()
    expect(probeMcp).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'assistantMcpIntegrations.test' }))
    expect(await screen.findByText('search_knowledge')).toBeVisible()
    expect(probeMcp).toHaveBeenCalledExactlyOnceWith('curated')
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        id: 'session',
        configuration: expect.objectContaining({ permission_mode: 'acceptEdits', opencode_mcp_ids: ['curated'] })
      })
    )
  })
})
