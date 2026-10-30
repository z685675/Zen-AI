import { getDefaultAssistant } from '@renderer/services/AssistantService'
import { getEffectiveMcpMode } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/store', () => ({ default: { getState: () => ({ llm: { providers: [] } }) } }))
vi.mock('@renderer/store/assistants', () => ({
  addAssistant: vi.fn(),
  addQuickAssistantId: vi.fn(),
  removeQuickAssistantId: vi.fn()
}))

describe('new conversation MCP default', () => {
  it('creates an explicit automatic preference without selecting or enabling services', () => {
    const assistant = getDefaultAssistant()
    expect(assistant.mcpMode).toBe('auto')
    expect(getEffectiveMcpMode(assistant)).toBe('auto')
    expect(assistant.mcpServers).toBeUndefined()
    assistant.mcpMode = 'disabled'
    expect(getDefaultAssistant().mcpMode).toBe('auto')
    expect(assistant.mcpMode).toBe('disabled')
  })
})
