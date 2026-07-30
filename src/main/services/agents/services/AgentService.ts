import { loggerService } from '@logger'
import { modelsService } from '@main/apiServer/services/models'
import {
  DEFAULT_AGENT_AVATAR,
  DEFAULT_CHERRY_CLAW_AGENT_ID,
  DEPRECATED_AGENT_NAME_PREFIX,
  isBuiltinAgentId
} from '@shared/config/agents'
import type {
  AgentEntity,
  CreateAgentRequest,
  CreateAgentResponse,
  GetAgentResponse,
  ListOptions,
  UpdateAgentRequest,
  UpdateAgentResponse
} from '@types'
import { AgentBaseSchema } from '@types'
import { asc, count, desc, eq, min } from 'drizzle-orm'

import { BaseService } from '../BaseService'
import { type AgentRow, agentsTable, type InsertAgentRow } from '../database/schema'
import type { AgentModelField } from '../errors'
import { seedWorkspaceTemplates } from './cherryclaw/seedWorkspace'

const logger = loggerService.withContext('AgentService')

type PreferredBuiltinRuntimeModel = {
  modelId: string
}

export class AgentService extends BaseService {
  static readonly DEFAULT_AGENT_ID = DEFAULT_CHERRY_CLAW_AGENT_ID
  static readonly DEFAULT_BUILTIN_MODEL_ID = 'gpt-5.6-luna'
  static readonly PREFERRED_BUILTIN_MODEL_IDS = [
    AgentService.DEFAULT_BUILTIN_MODEL_ID,
    'gpt-5.4-mini',
    'gpt-5-mini',
    'gpt-5.4',
    'gpt-5'
  ] as const
  private static readonly BUILTIN_MODEL_POLICY_KEY = 'builtin_default_model_policy'
  private static readonly BUILTIN_NEW_SESSION_MODEL_POLICY_KEY = 'builtin_new_session_model_policy'
  private static readonly NON_TEXT_MODEL_ID_PATTERN =
    /\b(embedding|rerank|image-generation|image|dall-e|tts|whisper|audio|speech|moderation)\b/i

  private static instance: AgentService | null = null
  private readonly modelFields: AgentModelField[] = ['model', 'plan_model', 'small_model']

  static getInstance(): AgentService {
    if (!AgentService.instance) {
      AgentService.instance = new AgentService()
    }
    return AgentService.instance
  }

  // Agent Methods
  async createAgent(req: CreateAgentRequest): Promise<CreateAgentResponse> {
    const id = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    const now = new Date().toISOString()

    req.configuration = {
      permission_mode: 'default',
      max_turns: 100,
      env_vars: {},
      avatar: DEFAULT_AGENT_AVATAR,
      ...req.configuration
    }
    req.accessible_paths = this.resolveAccessiblePaths(req.accessible_paths, id)

    await this.validateAgentModels(req.type, {
      model: req.model,
      plan_model: req.plan_model,
      small_model: req.small_model
    })

    const serializedReq = this.serializeJsonFields(req)

    const insertData: InsertAgentRow = {
      id,
      type: req.type,
      name: req.name || 'New Agent',
      description: req.description,
      instructions: req.instructions || 'You are a helpful assistant.',
      model: req.model,
      plan_model: req.plan_model,
      small_model: req.small_model,
      configuration: serializedReq.configuration,
      accessible_paths: serializedReq.accessible_paths,
      sort_order: 0,
      created_at: now,
      updated_at: now
    }

    const database = await this.getDatabase()
    const minSortResult = await database.select({ min: min(agentsTable.sort_order) }).from(agentsTable)
    const newSortOrder = (minSortResult[0]?.min ?? 0) - 1
    insertData.sort_order = newSortOrder
    await database.insert(agentsTable).values(insertData)
    const result = await database.select().from(agentsTable).where(eq(agentsTable.id, id)).limit(1)
    if (!result[0]) {
      throw new Error('Failed to create agent')
    }

    const agent = this.deserializeJsonFields(result[0]) as AgentEntity

    // Seed workspace templates for soul mode agents
    if ((req.configuration as Record<string, unknown> | undefined)?.soul_enabled === true) {
      const workspace = agent.accessible_paths?.[0]
      if (workspace) {
        await seedWorkspaceTemplates(workspace)
      }
    }

    return agent
  }

  async getAgent(id: string): Promise<GetAgentResponse | null> {
    const database = await this.getDatabase()
    const result = await database.select().from(agentsTable).where(eq(agentsTable.id, id)).limit(1)

    if (!result[0]) {
      return null
    }

    let agent = this.deserializeJsonFields(result[0]) as GetAgentResponse
    agent = await this.repairAgentAccessiblePaths(database, agent)
    const { tools, legacyIdMap } = await this.listMcpTools(agent.type, agent.mcps)
    agent.tools = tools
    agent.allowed_tools = this.normalizeAllowedTools(agent.allowed_tools, agent.tools, legacyIdMap)

    return agent
  }

  async listAgents(options: ListOptions = {}): Promise<{ agents: AgentEntity[]; total: number }> {
    // Build query with pagination
    const database = await this.getDatabase()
    const totalResult = await database.select({ count: count() }).from(agentsTable)

    const sortBy = options.sortBy || 'sort_order'
    const orderBy = options.orderBy || (sortBy === 'sort_order' ? 'asc' : 'desc')

    const sortField = agentsTable[sortBy]
    const orderFn = orderBy === 'asc' ? asc : desc

    // Use created_at DESC as secondary sort for tie-breaking (e.g., after migration when all sort_order = 0)
    const baseQuery =
      sortBy === 'sort_order'
        ? database.select().from(agentsTable).orderBy(orderFn(sortField), desc(agentsTable.created_at))
        : database.select().from(agentsTable).orderBy(orderFn(sortField))

    const result =
      options.limit !== undefined
        ? options.offset !== undefined
          ? await baseQuery.limit(options.limit).offset(options.offset)
          : await baseQuery.limit(options.limit)
        : await baseQuery

    const agents = await Promise.all(
      result.map(async (row) => {
        const agent = this.deserializeJsonFields(row) as GetAgentResponse
        return this.repairAgentAccessiblePaths(database, agent)
      })
    )

    await Promise.all(
      agents.map(async (agent) => {
        const { tools, legacyIdMap } = await this.listMcpTools(agent.type, agent.mcps)
        agent.tools = tools
        agent.allowed_tools = this.normalizeAllowedTools(agent.allowed_tools, agent.tools, legacyIdMap)
      })
    )

    return { agents, total: totalResult[0].count }
  }

  private extractProviderModelId(modelId: string): string {
    return modelId.includes(':') ? modelId.split(':').slice(1).join(':') : modelId
  }

  private normalizeProviderModelId(modelId: string): string {
    const providerModelId = this.extractProviderModelId(modelId).toLowerCase()
    return providerModelId.includes('/') ? providerModelId.split('/').pop() || providerModelId : providerModelId
  }

  private async repairAgentAccessiblePaths(
    database: Awaited<ReturnType<AgentService['getDatabase']>>,
    agent: GetAgentResponse
  ): Promise<GetAgentResponse> {
    const reconciled = this.reconcileAccessiblePaths(agent.accessible_paths, agent.id)
    if (!reconciled.changed) {
      return agent
    }

    await database
      .update(agentsTable)
      .set({
        accessible_paths: this.serializeJsonFields({ accessible_paths: reconciled.paths }).accessible_paths,
        updated_at: new Date().toISOString()
      })
      .where(eq(agentsTable.id, agent.id))

    return {
      ...agent,
      accessible_paths: reconciled.paths
    }
  }

  private getDeprecatedAgentDisplayName(name: string | undefined): string | null {
    const trimmedName = name?.trim()
    if (!trimmedName) {
      return null
    }

    if (trimmedName.startsWith(DEPRECATED_AGENT_NAME_PREFIX)) {
      return null
    }

    return `${DEPRECATED_AGENT_NAME_PREFIX}${trimmedName}`
  }

  private findPreferredBuiltinModelId(models: Array<{ id: string; provider_model_id?: string }>): string | null {
    if (models.length === 0) {
      return null
    }

    const normalizedModels = models.map((model) => ({
      id: model.id,
      providerModelId: this.normalizeProviderModelId(model.provider_model_id ?? model.id)
    }))

    for (const preferredModelId of AgentService.PREFERRED_BUILTIN_MODEL_IDS) {
      const match = normalizedModels.find((model) => model.providerModelId === preferredModelId)
      if (match) {
        return match.id
      }
    }

    const gptMatch = normalizedModels.find((model) => model.providerModelId.includes('gpt'))
    return gptMatch?.id ?? models[0]?.id ?? null
  }

  async getPreferredBuiltinModelId(): Promise<string | null> {
    const modelsRes = await modelsService.getModels({})
    const availableTextModels = (modelsRes.data ?? []).filter(
      (model) => !AgentService.NON_TEXT_MODEL_ID_PATTERN.test(model.provider_model_id ?? model.id)
    )
    const modelId = this.findPreferredBuiltinModelId(availableTextModels)

    if (modelId) {
      logger.info('Resolved preferred built-in agent model', { modelId })
    } else {
      logger.info('No available text model found for built-in agent')
    }

    return modelId
  }

  async getPreferredBuiltinRuntimeModel(): Promise<PreferredBuiltinRuntimeModel | null> {
    const modelId = await this.getPreferredBuiltinModelId()
    return modelId ? { modelId } : null
  }

  async listCompatibleAgents(): Promise<GetAgentResponse[]> {
    const database = await this.getDatabase()
    const rows = await database.select().from(agentsTable)

    return rows
      .map((row) => this.deserializeJsonFields(row) as GetAgentResponse)
      .filter((agent) => agent.type === 'claude-code')
  }

  async syncCompatibleAgentsToModel(modelId: string): Promise<string[]> {
    const database = await this.getDatabase()
    const compatibleAgents = await this.listCompatibleAgents()

    for (const agent of compatibleAgents) {
      if (agent.model === modelId) {
        continue
      }

      await database
        .update(agentsTable)
        .set({
          model: modelId,
          updated_at: new Date().toISOString()
        })
        .where(eq(agentsTable.id, agent.id))
    }

    logger.info('Synchronized compatible agents to preferred model', {
      modelId,
      total: compatibleAgents.length
    })

    return compatibleAgents.map((agent) => agent.id)
  }

  private shouldRefreshBuiltinInstructions(currentInstructions?: string, nextInstructions?: string): boolean {
    if (!currentInstructions || !nextInstructions) {
      return false
    }

    if (currentInstructions === nextInstructions) {
      return false
    }

    const legacyBuiltinIdentityPatterns = [
      /Xiao\s+Long\s+Xia\s+Official\s+Assistant/i,
      /小龙虾/,
      /小龙侠/,
      /Lobster/i,
      /CherryClaw/i,
      /Cherry\s+Studio\s+assistant/i
    ]

    return legacyBuiltinIdentityPatterns.some((pattern) => pattern.test(currentInstructions))
  }

  async markLegacyUserAgentsDeprecated(): Promise<number> {
    const database = await this.getDatabase()
    const agents = await this.listCompatibleAgents()
    let updatedCount = 0

    for (const agent of agents) {
      if (isBuiltinAgentId(agent.id)) {
        continue
      }

      const deprecatedName = this.getDeprecatedAgentDisplayName(agent.name)
      if (!deprecatedName) {
        continue
      }

      await database
        .update(agentsTable)
        .set({
          name: deprecatedName,
          updated_at: new Date().toISOString()
        })
        .where(eq(agentsTable.id, agent.id))

      updatedCount++
    }

    if (updatedCount > 0) {
      logger.info('Marked legacy user agents as deprecated', { updatedCount })
    }

    return updatedCount
  }

  /**
   * Initialize a built-in agent from its bundled agent.json template.
   * Called once at app startup. Safe to call multiple times, skips if the agent already exists.
   * Returns the agent ID if created or already present, or null if no compatible model is available yet.
   *
   * @param opts.id - Fixed agent ID
   * @param opts.builtinRole - Role key used by BuiltinAgentProvisioner (e.g. 'assistant')
   * @param opts.provisionWorkspace - Callback to provision skills/plugins into the workspace and return agent config
   */
  async initBuiltinAgent(opts: {
    id: string
    builtinRole: string
    provisionWorkspace: (
      workspacePath: string,
      builtinRole: string
    ) => Promise<
      | { name?: string; description?: string; instructions?: string; configuration?: Record<string, unknown> }
      | undefined
    >
  }): Promise<string | null> {
    const { id, builtinRole, provisionWorkspace } = opts
    try {
      const database = await this.getDatabase()
      const existing = await database
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(eq(agentsTable.id, id))
        .limit(1)

      if (existing.length > 0) {
        // Keep user-editable defaults intact. The official fusion prompt is
        // product-managed and refreshed so routing and safety rules stay current.
        const resolvedPaths = this.resolveAccessiblePaths([], id)
        const workspace = resolvedPaths[0]
        const agentConfig = workspace ? await provisionWorkspace(workspace, builtinRole) : undefined
        const existingAgent = await this.getAgent(id)
        let currentConfiguration = (existingAgent?.configuration ?? {}) as Record<string, unknown>

        if (workspace && agentConfig?.configuration?.soul_enabled === true) {
          await seedWorkspaceTemplates(workspace)
        }

        const updateData: Partial<InsertAgentRow> = {}
        let defaultModelPolicyUpdated = false

        if (
          builtinRole === 'fusion' &&
          currentConfiguration[AgentService.BUILTIN_NEW_SESSION_MODEL_POLICY_KEY] !==
            AgentService.DEFAULT_BUILTIN_MODEL_ID
        ) {
          const preferredModel = await this.getPreferredBuiltinRuntimeModel()
          if (
            preferredModel &&
            this.normalizeProviderModelId(preferredModel.modelId) === AgentService.DEFAULT_BUILTIN_MODEL_ID
          ) {
            updateData.model = preferredModel.modelId
            currentConfiguration = {
              ...currentConfiguration,
              [AgentService.BUILTIN_MODEL_POLICY_KEY]: AgentService.DEFAULT_BUILTIN_MODEL_ID,
              [AgentService.BUILTIN_NEW_SESSION_MODEL_POLICY_KEY]: AgentService.DEFAULT_BUILTIN_MODEL_ID
            }
            defaultModelPolicyUpdated = true
            logger.info('Migrating built-in assistant to the current new-session model policy', {
              agentId: id,
              modelId: preferredModel.modelId,
              policy: AgentService.DEFAULT_BUILTIN_MODEL_ID
            })
          }
        }

        if (
          agentConfig &&
          (agentConfig.name || agentConfig.description || agentConfig.instructions || agentConfig.configuration)
        ) {
          const mergedConfiguration = agentConfig.configuration
            ? {
                ...agentConfig.configuration,
                ...currentConfiguration,
                builtin_role: currentConfiguration.builtin_role ?? agentConfig.configuration.builtin_role
              }
            : currentConfiguration

          if (!existingAgent?.name && agentConfig.name) updateData.name = agentConfig.name
          if (!existingAgent?.description && agentConfig.description) updateData.description = agentConfig.description
          if (!existingAgent?.instructions && agentConfig.instructions) {
            updateData.instructions = agentConfig.instructions
          } else if (
            agentConfig.instructions &&
            (builtinRole === 'fusion' ||
              this.shouldRefreshBuiltinInstructions(existingAgent?.instructions, agentConfig.instructions))
          ) {
            updateData.instructions = agentConfig.instructions
          }
          if (agentConfig.configuration) {
            updateData.configuration = this.serializeJsonFields({ configuration: mergedConfiguration }).configuration
          }
        } else if (defaultModelPolicyUpdated) {
          updateData.configuration = this.serializeJsonFields({ configuration: currentConfiguration }).configuration
        }

        if (Object.keys(updateData).length > 0) {
          updateData.updated_at = new Date().toISOString()
          await database.update(agentsTable).set(updateData).where(eq(agentsTable.id, id))
        }

        return id
      }

      const preferredModel = await this.getPreferredBuiltinRuntimeModel()
      if (!preferredModel) {
        logger.info(`No available text models yet, skipping ${builtinRole} creation`)
        return null
      }

      // Resolve workspace path first so provisioner can copy template files
      const resolvedPaths = this.resolveAccessiblePaths([], id)
      const workspace = resolvedPaths[0]

      // Provision workspace (.claude/skills, plugins) and read agent.json config
      const agentConfig = workspace ? await provisionWorkspace(workspace, builtinRole) : undefined

      const now = new Date().toISOString()
      const configuration: CreateAgentRequest['configuration'] = {
        avatar: DEFAULT_AGENT_AVATAR,
        permission_mode: 'default',
        max_turns: 100,
        env_vars: {},
        ...agentConfig?.configuration,
        ...(this.normalizeProviderModelId(preferredModel.modelId) === AgentService.DEFAULT_BUILTIN_MODEL_ID
          ? {
              [AgentService.BUILTIN_MODEL_POLICY_KEY]: AgentService.DEFAULT_BUILTIN_MODEL_ID,
              [AgentService.BUILTIN_NEW_SESSION_MODEL_POLICY_KEY]: AgentService.DEFAULT_BUILTIN_MODEL_ID
            }
          : {})
      }

      const req: CreateAgentRequest = {
        type: 'claude-code',
        name: agentConfig?.name || builtinRole,
        description: agentConfig?.description || `Built-in ${builtinRole} agent`,
        instructions: agentConfig?.instructions || 'You are a helpful assistant.',
        model: preferredModel.modelId,
        accessible_paths: resolvedPaths,
        configuration
      }

      await this.validateAgentModels(req.type, { model: req.model })
      const serialized = this.serializeJsonFields(req)

      const insertData: InsertAgentRow = {
        id,
        type: req.type,
        name: req.name || builtinRole,
        description: req.description,
        instructions: req.instructions || 'You are a helpful assistant.',
        model: req.model,
        configuration: serialized.configuration,
        accessible_paths: serialized.accessible_paths,
        sort_order: 0,
        created_at: now,
        updated_at: now
      }

      const minSortResult = await database.select({ min: min(agentsTable.sort_order) }).from(agentsTable)
      const newSortOrder = (minSortResult[0]?.min ?? 0) - 1
      insertData.sort_order = newSortOrder
      await database.insert(agentsTable).values(insertData)

      if (workspace && configuration.soul_enabled === true) {
        await seedWorkspaceTemplates(workspace)
      }

      logger.info(`Created built-in ${builtinRole} agent`, { id })
      return id
    } catch (error) {
      logger.error(`Failed to init built-in ${builtinRole} agent`, error as Error)
      return null
    }
  }

  /**
   * Initialize the built-in CherryClaw agent with a fixed ID.
   * Called once at app startup. Safe to call multiple times, skips if the agent already exists.
   * Returns the agent ID if created or already present, or null if no compatible model is available yet.
   */
  async initDefaultCherryClawAgent(): Promise<string | null> {
    const id = AgentService.DEFAULT_AGENT_ID
    try {
      const database = await this.getDatabase()
      const existing = await database
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(eq(agentsTable.id, id))
        .limit(1)

      if (existing.length > 0) {
        return id
      }

      const preferredModel = await this.getPreferredBuiltinRuntimeModel()
      if (!preferredModel) {
        logger.info('No available text models yet, skipping default Zen Agent creation')
        return null
      }

      const now = new Date().toISOString()
      const configuration: CreateAgentRequest['configuration'] = {
        avatar: DEFAULT_AGENT_AVATAR,
        permission_mode: 'plan',
        max_turns: 100,
        soul_enabled: true,
        scheduler_enabled: true,
        scheduler_type: 'interval',
        heartbeat_enabled: true,
        heartbeat_interval: 30,
        env_vars: {}
      }

      const req: CreateAgentRequest = {
        type: 'claude-code',
        name: 'Zen Agent',
        description: 'Default autonomous Zen AI agent',
        model: preferredModel.modelId,
        accessible_paths: [],
        configuration
      }

      const resolvedPaths = this.resolveAccessiblePaths(req.accessible_paths, id)
      await this.validateAgentModels(req.type, { model: req.model })

      const serialized = this.serializeJsonFields({ ...req, accessible_paths: resolvedPaths })

      const insertData: InsertAgentRow = {
        id,
        type: req.type,
        name: req.name || 'Zen Agent',
        description: req.description,
        instructions: 'You are a helpful assistant.',
        model: req.model,
        configuration: serialized.configuration,
        accessible_paths: serialized.accessible_paths,
        sort_order: 0,
        created_at: now,
        updated_at: now
      }

      const minSortResult = await database.select({ min: min(agentsTable.sort_order) }).from(agentsTable)
      const newSortOrder = (minSortResult[0]?.min ?? 0) - 1
      insertData.sort_order = newSortOrder
      await database.insert(agentsTable).values(insertData)

      // Seed workspace templates for soul mode
      const workspace = resolvedPaths?.[0]
      if (workspace) {
        await seedWorkspaceTemplates(workspace)
      }

      logger.info('Created default Zen Agent', { id })
      return id
    } catch (error) {
      logger.error('Failed to init default Zen Agent', error as Error)
      return null
    }
  }

  async updateAgent(
    id: string,
    updates: UpdateAgentRequest,
    options: { replace?: boolean } = {}
  ): Promise<UpdateAgentResponse | null> {
    // Check if agent exists
    const existing = await this.getAgent(id)
    if (!existing) {
      return null
    }

    const now = new Date().toISOString()

    if (updates.accessible_paths !== undefined) {
      if (updates.accessible_paths.length === 0) {
        throw new Error('accessible_paths must not be empty')
      }
      updates.accessible_paths = this.resolveAccessiblePaths(updates.accessible_paths, id)
    }

    const modelUpdates: Partial<Record<AgentModelField, string | undefined>> = {}
    for (const field of this.modelFields) {
      if (Object.prototype.hasOwnProperty.call(updates, field)) {
        modelUpdates[field] = updates[field as keyof UpdateAgentRequest] as string | undefined
      }
    }

    if (Object.keys(modelUpdates).length > 0) {
      await this.validateAgentModels(existing.type, modelUpdates)
    }

    const serializedUpdates = this.serializeJsonFields(updates)

    const updateData: Partial<AgentRow> = {
      updated_at: now
    }
    const replaceableFields = Object.keys(AgentBaseSchema.shape) as (keyof AgentRow)[]
    const shouldReplace = options.replace ?? false

    for (const field of replaceableFields) {
      if (shouldReplace || Object.prototype.hasOwnProperty.call(serializedUpdates, field)) {
        if (Object.prototype.hasOwnProperty.call(serializedUpdates, field)) {
          const value = serializedUpdates[field as keyof typeof serializedUpdates]
          ;(updateData as Record<string, unknown>)[field] = value ?? null
        } else if (shouldReplace) {
          ;(updateData as Record<string, unknown>)[field] = null
        }
      }
    }

    const database = await this.getDatabase()
    await database.update(agentsTable).set(updateData).where(eq(agentsTable.id, id))
    return await this.getAgent(id)
  }

  async reorderAgents(orderedIds: string[]): Promise<void> {
    const database = await this.getDatabase()
    await database.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.update(agentsTable).set({ sort_order: i }).where(eq(agentsTable.id, orderedIds[i]))
      }
    })
    logger.info('Agents reordered', { count: orderedIds.length })
  }

  async deleteAgent(id: string): Promise<boolean> {
    const database = await this.getDatabase()
    const result = await database.delete(agentsTable).where(eq(agentsTable.id, id))

    return result.rowsAffected > 0
  }

  async agentExists(id: string): Promise<boolean> {
    const database = await this.getDatabase()
    const result = await database
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(eq(agentsTable.id, id))
      .limit(1)

    return result.length > 0
  }
}

export const agentService = AgentService.getInstance()
