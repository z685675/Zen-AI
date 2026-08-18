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

import { AgentService } from '../AgentService'

const getModelsMock = vi.mocked(modelsService.getModels)

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

  it('does not store a runtime override when creating a built-in Auto agent', async () => {
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
      id: 'builtin-fusion',
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

    expect(result).toBe('builtin-fusion')
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
