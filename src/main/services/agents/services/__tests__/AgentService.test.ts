import type { ApiModel } from '@types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const remotePolicyRefreshMock = vi.hoisted(() => vi.fn())

vi.mock('@main/apiServer/services/models', () => ({
  modelsService: {
    getModels: vi.fn()
  }
}))

vi.mock('@main/services/RemoteModelPolicyService', () => ({
  remoteModelPolicyService: {
    refresh: remotePolicyRefreshMock
  }
}))

vi.mock('@main/apiServer/services/mcp', () => ({
  mcpApiService: {
    getServerInfo: vi.fn()
  }
}))

vi.mock('@main/apiServer/utils', () => ({
  validateModelId: vi.fn()
}))

vi.mock('@main/utils', () => ({
  getDataPath: () => 'C:\\ZenAI\\data'
}))

import { modelsService } from '@main/apiServer/services/models'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'

import { AgentService } from '../AgentService'
import { DEFAULT_ASSISTANT_DESCRIPTION, DEFAULT_ASSISTANT_INSTRUCTIONS } from '../opencode/defaults'

const getModelsMock = vi.mocked(modelsService.getModels)

describe('official assistant prompt protection on save', () => {
  it.each([
    { id: DEFAULT_OPENCODE_AGENT_ID, replace: false, includeInstructions: true, protected: true },
    { id: DEFAULT_OPENCODE_AGENT_ID, replace: true, includeInstructions: true, protected: true },
    { id: DEFAULT_OPENCODE_AGENT_ID, replace: true, includeInstructions: false, protected: true },
    { id: 'custom-agent', replace: false, includeInstructions: true, protected: false }
  ])('preserves official instructions and permits custom instructions %#', async (fixture) => {
    const service = new AgentService() as AgentService & {
      getDatabase: ReturnType<typeof vi.fn>
      getAgent: ReturnType<typeof vi.fn>
    }
    service.getAgent = vi.fn().mockResolvedValue({ id: fixture.id, instructions: 'Existing official prompt' })
    const set = vi.fn<(updates: unknown) => { where: ReturnType<typeof vi.fn> }>(() => ({
      where: vi.fn().mockResolvedValue({ rowsAffected: 1 })
    }))
    service.getDatabase = vi.fn().mockResolvedValue({ update: () => ({ set }) })
    const updates = {
      name: 'Updated settings',
      ...(fixture.includeInstructions && { instructions: 'Edited prompt' })
    }

    await service.updateAgent(fixture.id, updates, { replace: fixture.replace })

    const saved = set.mock.calls[0][0]
    expect(saved).toHaveProperty('name', 'Updated settings')
    if (fixture.protected) expect(saved).not.toHaveProperty('instructions')
    else expect(saved).toHaveProperty('instructions', 'Edited prompt')
    if (fixture.includeInstructions) expect(updates.instructions).toBe('Edited prompt')
  })
})

const setRemoteTarget = (target?: string) => {
  remotePolicyRefreshMock.mockResolvedValue({
    version: target ? 2 : 0,
    fetchedAt: '2026-08-19T00:00:00.000Z',
    appliedAt: '2026-08-19T00:00:00.000Z',
    source: target ? 'remote' : 'builtin',
    policy: {
      schemaVersion: 1,
      version: target ? 2 : 0,
      defaults: {
        chat: target ?? '',
        quick: target ?? '',
        translate: target ?? '',
        assistant: target ?? '',
        assistantNewSession: target ?? ''
      },
      assistant: {
        nonDeveloperAllowlist: [],
        developerAllowlist: [],
        blockedModels: [],
        fallbackModels: []
      },
      rules: {
        applyToNewSessions: true,
        overwriteUserChoice: false,
        preserveExistingSessions: true,
        developerModeBypassAllowlist: true
      }
    }
  })
}

function makeModel(overrides: Partial<ApiModel> & Pick<ApiModel, 'id'>): ApiModel {
  return {
    object: 'model',
    created: 0,
    name: overrides.id,
    owned_by: overrides.provider ?? 'test',
    ...overrides
  }
}

describe('AgentService built-in model resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setRemoteTarget()
  })

  it('returns null when no remote assistant default is configured', async () => {
    getModelsMock.mockResolvedValueOnce({
      object: 'list',
      data: [
        makeModel({
          id: 'gateway:claude-opus-4-6',
          provider: 'gateway',
          provider_model_id: 'claude-opus-4-6'
        })
      ]
    })

    const service = new AgentService()

    await expect(service.getPreferredBuiltinRuntimeModel()).resolves.toBeNull()
  })

  it('selects the remotely configured text model without binding a runtime', async () => {
    setRemoteTarget('claude-sonnet-4')
    getModelsMock.mockResolvedValueOnce({
      object: 'list',
      data: [
        makeModel({
          id: 'anthropic:claude-sonnet-4',
          provider: 'anthropic',
          provider_type: 'anthropic',
          provider_model_id: 'claude-sonnet-4',
          agent_runtime_compatibility: ['claude-code']
        })
      ]
    })

    const service = new AgentService()
    const resolved = await service.getPreferredBuiltinRuntimeModel()

    expect(resolved).toEqual({ modelId: 'anthropic:claude-sonnet-4' })
    expect(getModelsMock).toHaveBeenCalledTimes(1)
    expect(getModelsMock).toHaveBeenCalledWith({})
  })

  it('keeps OpenAI-type Claude models available to the built-in Auto agent', async () => {
    setRemoteTarget('claude-opus-4-6')
    getModelsMock.mockResolvedValueOnce({
      object: 'list',
      data: [
        makeModel({
          id: 'gateway:claude-opus-4-6',
          provider: 'gateway',
          provider_type: 'openai',
          provider_model_id: 'claude-opus-4-6',
          agent_runtime_compatibility: ['claude-code', 'codex']
        })
      ]
    })

    const service = new AgentService()
    await expect(service.getPreferredBuiltinRuntimeModel()).resolves.toEqual({
      modelId: 'gateway:claude-opus-4-6'
    })

    expect(getModelsMock).toHaveBeenCalledTimes(1)
  })

  it('prefers a configured GPT model while excluding non-text models', async () => {
    setRemoteTarget('gpt-5-mini')
    getModelsMock.mockResolvedValueOnce({
      object: 'list',
      data: [
        makeModel({
          id: 'openai:text-embedding-3-large',
          provider: 'openai',
          provider_type: 'openai',
          provider_model_id: 'text-embedding-3-large',
          endpoint_type: 'openai',
          agent_runtime_compatibility: ['codex']
        }),
        makeModel({
          id: 'openai:gpt-5-mini',
          provider: 'openai',
          provider_type: 'openai',
          provider_model_id: 'gpt-5-mini',
          endpoint_type: 'openai',
          agent_runtime_compatibility: ['codex']
        })
      ]
    })

    const service = new AgentService()
    const resolved = await service.getPreferredBuiltinRuntimeModel()

    expect(resolved).toEqual({ modelId: 'openai:gpt-5-mini' })
    expect(getModelsMock).toHaveBeenCalledTimes(1)
  })

  it('uses the remote target instead of a bundled model preference', async () => {
    setRemoteTarget('gpt-5.6-luna')
    getModelsMock.mockResolvedValueOnce({
      object: 'list',
      data: [
        makeModel({
          id: 'zen:gpt-5.4-mini',
          provider: 'zen',
          provider_type: 'openai',
          provider_model_id: 'gpt-5.4-mini'
        }),
        makeModel({
          id: 'zen:gpt-5.6-luna',
          provider: 'zen',
          provider_type: 'openai',
          provider_model_id: 'gpt-5.6-luna'
        })
      ]
    })

    const service = new AgentService()

    await expect(service.getPreferredBuiltinRuntimeModel()).resolves.toEqual({
      modelId: 'zen:gpt-5.6-luna'
    })
  })

  it('returns null when there are no available text models', async () => {
    setRemoteTarget('gpt-5.6-luna')
    getModelsMock.mockResolvedValueOnce({
      object: 'list',
      data: []
    })

    const service = new AgentService()
    await expect(service.getPreferredBuiltinRuntimeModel()).resolves.toBeNull()

    expect(getModelsMock).toHaveBeenCalledTimes(1)
    expect(getModelsMock).toHaveBeenCalledWith({})
  })

  it('uses model preference rather than provider runtime metadata for mixed gateways', async () => {
    setRemoteTarget('gpt-5-mini')
    getModelsMock.mockResolvedValueOnce({
      object: 'list',
      data: [
        makeModel({
          id: 'new-api:claude-sonnet-4',
          provider: 'new-api',
          provider_type: 'new-api',
          provider_model_id: 'claude-sonnet-4',
          endpoint_type: 'anthropic',
          agent_runtime_compatibility: ['claude-code']
        }),
        makeModel({
          id: 'new-api:openai/gpt-5-mini',
          provider: 'new-api',
          provider_type: 'new-api',
          provider_model_id: 'openai/gpt-5-mini',
          endpoint_type: 'openai-response',
          agent_runtime_compatibility: ['codex']
        })
      ]
    })

    const service = new AgentService()
    const resolved = await service.getPreferredBuiltinRuntimeModel()

    expect(resolved).toEqual({ modelId: 'new-api:openai/gpt-5-mini' })
  })

  it.each([
    { id: 'builtin-fusion', name: 'Fusion' },
    { id: 'lobster-fusion-default', name: '请弃用旧助手' }
  ])('creates a built-in agent with its display name and no runtime override ($id)', async ({ id, name }) => {
    const service = new AgentService() as AgentService & {
      getDatabase: ReturnType<typeof vi.fn>
      getPreferredBuiltinRuntimeModel: ReturnType<typeof vi.fn>
      resolveAccessiblePaths: ReturnType<typeof vi.fn>
      validateAgentModels: ReturnType<typeof vi.fn>
    }

    service.getPreferredBuiltinRuntimeModel = vi.fn().mockResolvedValue({
      modelId: 'openai:gpt-5-mini'
    })
    service.resolveAccessiblePaths = vi.fn().mockReturnValue(['C:\\workspace'])
    service.validateAgentModels = vi.fn().mockResolvedValue(undefined)

    let insertedAgent: any
    const database = {
      select: vi.fn((selection: Record<string, unknown>) => {
        if (Object.prototype.hasOwnProperty.call(selection, 'id')) {
          return {
            from: () => ({
              where: () => ({
                limit: async () => []
              })
            })
          }
        }

        return {
          from: async () => [{ min: 0 }]
        }
      }),
      insert: vi.fn(() => ({
        values: vi.fn(async (value) => {
          insertedAgent = value
        })
      }))
    }
    service.getDatabase = vi.fn().mockResolvedValue(database)

    const result = await service.initBuiltinAgent({
      id,
      builtinRole: 'fusion',
      provisionWorkspace: vi.fn().mockResolvedValue({
        name: 'Fusion',
        description: 'Built-in fusion',
        instructions: 'Finish user tasks',
        configuration: {
          builtin_role: 'fusion',
          permission_mode: 'bypassPermissions'
        }
      })
    })

    expect(result).toBe(id)
    expect(insertedAgent.name).toBe(name)
    expect(insertedAgent.model).toBe('openai:gpt-5-mini')
    expect(JSON.parse(insertedAgent.configuration)).toMatchObject({
      builtin_role: 'fusion',
      permission_mode: 'bypassPermissions'
    })
    expect(JSON.parse(insertedAgent.configuration)).not.toHaveProperty('agent_runtime')
  })

  it('does not rewrite an existing built-in agent during startup', async () => {
    const service = new AgentService() as AgentService & {
      getDatabase: ReturnType<typeof vi.fn>
      getPreferredBuiltinRuntimeModel: ReturnType<typeof vi.fn>
      getAgent: ReturnType<typeof vi.fn>
      resolveAccessiblePaths: ReturnType<typeof vi.fn>
    }

    service.getPreferredBuiltinRuntimeModel = vi.fn().mockResolvedValue({
      modelId: 'openai:gpt-5-mini',
      agentRuntime: 'codex'
    })
    service.getAgent = vi.fn().mockResolvedValue({
      id: 'builtin-fusion',
      type: 'claude-code',
      name: 'Fusion',
      model: 'openai:gpt-5-mini',
      accessible_paths: ['C:\\workspace'],
      configuration: {
        builtin_role: 'fusion',
        permission_mode: 'bypassPermissions',
        agent_runtime: 'claude-code'
      }
    })
    service.resolveAccessiblePaths = vi.fn().mockReturnValue(['C:\\workspace'])

    const database = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 'builtin-fusion' }]
          })
        })
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => undefined)
        }))
      }))
    }
    service.getDatabase = vi.fn().mockResolvedValue(database)

    const result = await service.initBuiltinAgent({
      id: 'builtin-fusion',
      builtinRole: 'fusion',
      provisionWorkspace: vi.fn().mockResolvedValue(undefined)
    })

    expect(result).toBe('builtin-fusion')
    expect(service.getPreferredBuiltinRuntimeModel).not.toHaveBeenCalled()
    expect(database.update).not.toHaveBeenCalled()
  })

  it('does not migrate an existing built-in model to a bundled default', async () => {
    const service = new AgentService() as AgentService & {
      getDatabase: ReturnType<typeof vi.fn>
      getPreferredBuiltinRuntimeModel: ReturnType<typeof vi.fn>
      getAgent: ReturnType<typeof vi.fn>
      resolveAccessiblePaths: ReturnType<typeof vi.fn>
    }

    service.getPreferredBuiltinRuntimeModel = vi.fn().mockResolvedValue({
      modelId: 'zen:gpt-5.6-luna'
    })
    service.getAgent = vi.fn().mockResolvedValue({
      id: 'builtin-fusion',
      type: 'claude-code',
      name: 'Fusion',
      model: 'zen:gpt-5.4-mini',
      accessible_paths: ['C:\\workspace'],
      configuration: {
        builtin_default_model_policy: 'gpt-5.6-luna',
        builtin_role: 'fusion',
        permission_mode: 'bypassPermissions'
      }
    })
    service.resolveAccessiblePaths = vi.fn().mockReturnValue(['C:\\workspace'])

    let updatedAgent: any
    const database = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 'builtin-fusion' }]
          })
        })
      })),
      update: vi.fn(() => ({
        set: vi.fn((value) => {
          updatedAgent = value
          return { where: vi.fn(async () => undefined) }
        })
      }))
    }
    service.getDatabase = vi.fn().mockResolvedValue(database)

    const result = await service.initBuiltinAgent({
      id: 'builtin-fusion',
      builtinRole: 'fusion',
      provisionWorkspace: vi.fn().mockResolvedValue({
        configuration: {
          builtin_role: 'fusion',
          permission_mode: 'bypassPermissions'
        }
      })
    })

    expect(result).toBe('builtin-fusion')
    expect(updatedAgent).not.toHaveProperty('model')
    expect(JSON.parse(updatedAgent.configuration)).toMatchObject({
      builtin_default_model_policy: 'gpt-5.6-luna',
      builtin_role: 'fusion',
      permission_mode: 'bypassPermissions'
    })
    expect(JSON.parse(updatedAgent.configuration)).not.toHaveProperty('builtin_new_session_model_policy')
    expect(JSON.parse(updatedAgent.configuration)).not.toHaveProperty('agent_runtime')
  })

  it('preserves a later user model choice after the gpt-5.6-luna policy migration completed', async () => {
    const service = new AgentService() as AgentService & {
      getDatabase: ReturnType<typeof vi.fn>
      getPreferredBuiltinRuntimeModel: ReturnType<typeof vi.fn>
      getAgent: ReturnType<typeof vi.fn>
      resolveAccessiblePaths: ReturnType<typeof vi.fn>
    }

    service.getPreferredBuiltinRuntimeModel = vi.fn()
    service.getAgent = vi.fn().mockResolvedValue({
      id: 'builtin-fusion',
      type: 'claude-code',
      name: 'Fusion',
      model: 'zen:claude-opus-4-8',
      accessible_paths: ['C:\\workspace'],
      configuration: {
        builtin_default_model_policy: 'gpt-5.6-luna',
        builtin_new_session_model_policy: 'gpt-5.6-luna',
        builtin_role: 'fusion',
        permission_mode: 'bypassPermissions'
      }
    })
    service.resolveAccessiblePaths = vi.fn().mockReturnValue(['C:\\workspace'])

    let updatedAgent: any
    const database = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 'builtin-fusion' }]
          })
        })
      })),
      update: vi.fn(() => ({
        set: vi.fn((value) => {
          updatedAgent = value
          return { where: vi.fn(async () => undefined) }
        })
      }))
    }
    service.getDatabase = vi.fn().mockResolvedValue(database)

    await service.initBuiltinAgent({
      id: 'builtin-fusion',
      builtinRole: 'fusion',
      provisionWorkspace: vi.fn().mockResolvedValue({
        configuration: {
          builtin_role: 'fusion',
          permission_mode: 'bypassPermissions'
        }
      })
    })

    expect(service.getPreferredBuiltinRuntimeModel).not.toHaveBeenCalled()
    expect(updatedAgent).not.toHaveProperty('model')
  })

  it.each(['zen-opencode-default', 'lobster-fusion-default', 'custom-builtin'])(
    'refreshes managed display identities and preserves user defaults (%s)',
    async (id) => {
      const service = new AgentService() as AgentService & {
        getDatabase: ReturnType<typeof vi.fn>
        getPreferredBuiltinRuntimeModel: ReturnType<typeof vi.fn>
        getAgent: ReturnType<typeof vi.fn>
        resolveAccessiblePaths: ReturnType<typeof vi.fn>
      }
      service.getPreferredBuiltinRuntimeModel = vi.fn()
      service.getAgent = vi.fn().mockResolvedValue({
        id,
        name: '新版助手',
        model: 'zen:gemini-user-choice',
        configuration: { avatar: '🩶', permission_mode: 'plan', custom_setting: 'keep' }
      })
      service.resolveAccessiblePaths = vi.fn().mockReturnValue(['C:\\workspace'])
      let updatedAgent: Record<string, unknown> = {}
      const database = {
        select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [{ id }] }) }) })),
        update: vi.fn(() => ({
          set: vi.fn((value: Record<string, unknown>) => {
            updatedAgent = value
            return { where: vi.fn(async () => undefined) }
          })
        }))
      }
      service.getDatabase = vi.fn().mockResolvedValue(database)

      expect(
        await service.initBuiltinAgent({
          id,
          builtinRole: 'fusion',
          provisionWorkspace: vi.fn().mockResolvedValue({
            name: '智能助手',
            configuration: { avatar: '❤️', permission_mode: 'default', assistant_engine: 'opencode' }
          })
        })
      ).toBe(id)

      if (id === 'zen-opencode-default') {
        expect(updatedAgent.name).toBe('智能助手')
      } else if (id === 'lobster-fusion-default') {
        expect(updatedAgent.name).toBe('请弃用旧助手')
      } else {
        expect(updatedAgent).not.toHaveProperty('name')
      }
      expect(JSON.parse(String(updatedAgent.configuration))).toMatchObject({
        avatar: '🩶',
        permission_mode: 'plan',
        custom_setting: 'keep'
      })
      expect(updatedAgent).not.toHaveProperty('model')
      expect(updatedAgent).not.toHaveProperty('accessible_paths')
      expect(service.getPreferredBuiltinRuntimeModel).not.toHaveBeenCalled()
    }
  )

  it.each([
    {
      label: 'old default',
      description: 'Zen AI 智能助手，使用 OpenCode 执行任务、处理文件和操作浏览器。',
      instructions:
        'You are Zen AI New Assistant. Help the user finish tasks using the tools actually available in this session. Answer simple greetings directly. Never claim to have configured background tasks, messaging or cross-conversation memory without an actual connected tool and authorization.',
      refresh: true
    },
    {
      label: 'older description',
      description: 'Zen AI 新版助手，使用 OpenCode 执行任务、处理文件和操作浏览器。',
      instructions: DEFAULT_ASSISTANT_INSTRUCTIONS,
      refresh: true
    },
    { label: 'missing defaults', description: undefined, instructions: undefined, refresh: true },
    { label: 'blank defaults', description: '  ', instructions: '  ', refresh: true },
    {
      label: 'user customizations',
      description: '我的资料助手',
      instructions: '请优先使用中文整理资料。',
      refresh: false
    }
  ])('updates $label without resetting the saved avatar or custom prompt', async (fixture) => {
    const service = new AgentService() as AgentService & {
      getDatabase: ReturnType<typeof vi.fn>
      getAgent: ReturnType<typeof vi.fn>
      resolveAccessiblePaths: ReturnType<typeof vi.fn>
    }
    const id = 'zen-opencode-default'
    service.getAgent = vi.fn().mockResolvedValue({
      id,
      name: '智能助手',
      description: fixture.description,
      instructions: fixture.instructions,
      configuration: { avatar: '🌻', permission_mode: 'plan' }
    })
    service.resolveAccessiblePaths = vi.fn().mockReturnValue(['C:\\workspace'])
    let updatedAgent: Record<string, unknown> = {}
    service.getDatabase = vi.fn().mockResolvedValue({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id }] }) }) }),
      update: () => ({
        set: (value: Record<string, unknown>) => {
          updatedAgent = value
          return { where: async () => undefined }
        }
      })
    })
    const options = {
      id,
      builtinRole: 'fusion',
      provisionWorkspace: vi.fn().mockResolvedValue({
        description: DEFAULT_ASSISTANT_DESCRIPTION,
        instructions: DEFAULT_ASSISTANT_INSTRUCTIONS,
        configuration: { avatar: '❤️', permission_mode: 'default' }
      })
    }

    // Repeated provisioning also runs when settings are reopened and after restart.
    await service.initBuiltinAgent(options)
    await service.initBuiltinAgent(options)
    expect(JSON.parse(String(updatedAgent.configuration))).toMatchObject({ avatar: '🌻', permission_mode: 'plan' })
    if (fixture.refresh) {
      expect(updatedAgent.description).toBe(DEFAULT_ASSISTANT_DESCRIPTION)
      expect(updatedAgent.instructions).toBe(DEFAULT_ASSISTANT_INSTRUCTIONS)
    } else {
      expect(updatedAgent).not.toHaveProperty('description')
      expect(updatedAgent).not.toHaveProperty('instructions')
    }
  })

  it('refreshes the product-managed prompt for the existing official assistant', async () => {
    const service = new AgentService() as AgentService & {
      getDatabase: ReturnType<typeof vi.fn>
      getPreferredBuiltinRuntimeModel: ReturnType<typeof vi.fn>
      getAgent: ReturnType<typeof vi.fn>
      resolveAccessiblePaths: ReturnType<typeof vi.fn>
    }

    service.getPreferredBuiltinRuntimeModel = vi.fn()
    service.getAgent = vi.fn().mockResolvedValue({
      id: 'builtin-fusion',
      type: 'claude-code',
      name: 'Fusion',
      model: 'zen:gpt-5.6-luna',
      instructions: 'Previous official prompt',
      accessible_paths: ['C:\\workspace'],
      configuration: {
        builtin_default_model_policy: 'gpt-5.6-luna',
        builtin_new_session_model_policy: 'gpt-5.6-luna',
        builtin_role: 'fusion',
        permission_mode: 'bypassPermissions'
      }
    })
    service.resolveAccessiblePaths = vi.fn().mockReturnValue(['C:\\workspace'])

    let updatedAgent: any
    const database = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 'builtin-fusion' }]
          })
        })
      })),
      update: vi.fn(() => ({
        set: vi.fn((value) => {
          updatedAgent = value
          return { where: vi.fn(async () => undefined) }
        })
      }))
    }
    service.getDatabase = vi.fn().mockResolvedValue(database)

    await service.initBuiltinAgent({
      id: 'builtin-fusion',
      builtinRole: 'fusion',
      provisionWorkspace: vi.fn().mockResolvedValue({
        instructions: 'Updated official prompt with implicit Skill routing',
        configuration: {
          builtin_role: 'fusion',
          permission_mode: 'bypassPermissions'
        }
      })
    })

    expect(updatedAgent.instructions).toBe('Updated official prompt with implicit Skill routing')
    expect(updatedAgent).not.toHaveProperty('model')
  })

  it('does not rewrite an existing default agent model or runtime during startup', async () => {
    const service = new AgentService() as AgentService & {
      getDatabase: ReturnType<typeof vi.fn>
      getPreferredBuiltinModelId: ReturnType<typeof vi.fn>
      getAgent: ReturnType<typeof vi.fn>
    }

    service.getPreferredBuiltinModelId = vi.fn().mockResolvedValue('anthropic:claude-sonnet-4')
    service.getAgent = vi.fn().mockResolvedValue({
      id: 'lobster-fusion-default',
      type: 'claude-code',
      name: 'Official Assistant',
      model: 'openai:gpt-5-mini',
      accessible_paths: ['C:\\workspace'],
      configuration: {
        builtin_role: 'fusion',
        permission_mode: 'bypassPermissions',
        agent_runtime: 'codex'
      }
    })

    const database = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: 'lobster-fusion-default' }]
          })
        })
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => undefined)
        }))
      }))
    }
    service.getDatabase = vi.fn().mockResolvedValue(database)

    const result = await service.initDefaultCherryClawAgent()

    expect(result).toBe(AgentService.DEFAULT_AGENT_ID)
    expect(service.getPreferredBuiltinModelId).not.toHaveBeenCalled()
    expect(service.getAgent).not.toHaveBeenCalled()
    expect(database.update).not.toHaveBeenCalled()
  })
})
