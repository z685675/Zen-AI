import { configureStore } from '@reduxjs/toolkit'
import type { Assistant, MCPTool, Model } from '@renderer/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AvailableTools,
  buildSystemPromptWithThinkTool,
  buildSystemPromptWithTools,
  replacePromptVariables,
  SYSTEM_PROMPT,
  THINK_TOOL_PROMPT,
  ToolUseExamples
} from '../prompt'

const mockApi = {
  system: {
    getDeviceType: vi.fn()
  },
  getAppInfo: vi.fn()
}

vi.mock('@renderer/store', () => {
  const mockStore = configureStore({
    reducer: {
      settings: (state = { language: 'zh-CN', userName: 'MockUser' }) => state
    }
  })

  return {
    default: mockStore,
    __esModule: true
  }
})

Object.defineProperty(window, 'api', {
  value: mockApi,
  writable: true
})

const createTool = (id: string, description: string): MCPTool =>
  ({
    id,
    serverId: 'server-1',
    serverName: 'Test Server',
    name: id,
    description,
    inputSchema: {
      type: 'object',
      title: `${id}-schema`,
      properties: {}
    },
    type: 'mcp'
  }) as MCPTool

const createAssistant = (modelName: string): Assistant =>
  ({
    id: 'assistant-1',
    name: 'Test Assistant',
    prompt: 'You are helpful.',
    topics: [],
    type: 'assistant',
    model: {
      id: modelName,
      name: modelName,
      provider: 'mock'
    } as Model
  }) as Assistant

describe('prompt utils', () => {
  const mockDate = new Date('2024-01-01T12:00:00Z')

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(mockDate)
    mockApi.system.getDeviceType.mockResolvedValue('macOS')
    mockApi.getAppInfo.mockResolvedValue({ arch: 'darwin64' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders available tools as XML', () => {
    const result = AvailableTools([createTool('web_search', 'Search the web')])

    expect(result).toContain('<tools>')
    expect(result).toContain('<name>web_search</name>')
    expect(result).toContain('Search the web')
    expect(result).toContain('"title":"web_search-schema"')
  })

  it('replaces supported prompt variables', async () => {
    const prompt =
      'Date={{date}} Time={{time}} DateTime={{datetime}} System={{system}} Arch={{arch}} Language={{language}} User={{username}} Model={{model_name}}'

    const result = await replacePromptVariables(prompt, createAssistant('Super-Model-X').model?.name)

    expect(result).toContain('System=macOS')
    expect(result).toContain('Arch=darwin64')
    expect(result).toContain('Language=zh-CN')
    expect(result).toContain('User=MockUser')
    expect(result).toContain('Model=Super-Model-X')
    expect(result).not.toContain('{{')
  })

  it('uses fallback values when system APIs fail', async () => {
    mockApi.system.getDeviceType.mockRejectedValue(new Error('API Error'))
    mockApi.getAppInfo.mockRejectedValue(new Error('API Error'))

    const result = await replacePromptVariables('System={{system}}, Architecture={{arch}}')

    expect(result).toBe('System=Unknown System, Architecture=Unknown Architecture')
  })

  it('returns non-string prompts unchanged', async () => {
    expect(await replacePromptVariables(null as any)).toBe(null)
  })

  it('builds the tool prompt when tools are present', async () => {
    const assistant = createAssistant('Advanced-AI-Model')
    const basePrompt = await replacePromptVariables('Be helpful.', assistant.model?.name)
    const tools = [createTool('web_search', 'Search the web')]

    const finalPrompt = buildSystemPromptWithTools(basePrompt, tools)
    const expected = SYSTEM_PROMPT.replace('{{ USER_SYSTEM_PROMPT }}', basePrompt)
      .replace('{{ TOOL_USE_EXAMPLES }}', ToolUseExamples)
      .replace('{{ AVAILABLE_TOOLS }}', AvailableTools(tools))

    expect(finalPrompt).toBe(expected)
    expect(finalPrompt).toContain('## Tool Use Formatting')
  })

  it('returns the original prompt when no tools are provided', () => {
    expect(buildSystemPromptWithTools('Be helpful.', [])).toBe('Be helpful.')
  })

  it('builds the think-only prompt', async () => {
    const assistant = createAssistant('Advanced-AI-Model')
    const basePrompt = await replacePromptVariables('Be helpful.', assistant.model?.name)

    expect(buildSystemPromptWithThinkTool(basePrompt)).toBe(
      THINK_TOOL_PROMPT.replace('{{ USER_SYSTEM_PROMPT }}', basePrompt)
    )
  })
})
