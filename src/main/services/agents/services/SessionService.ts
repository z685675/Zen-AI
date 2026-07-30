import * as fs from 'node:fs'
import * as path from 'node:path'

import { loggerService } from '@logger'
import { configManager } from '@main/services/ConfigManager'
import { toAsarUnpackedPath } from '@main/utils'
import { parsePluginMetadata, parseSkillMetadata } from '@main/utils/markdownParser'
import type { SlashCommand, UpdateSessionResponse } from '@types'
import {
  AgentBaseSchema,
  type AgentEntity,
  type AgentSessionEntity,
  type CreateSessionRequest,
  type GetAgentSessionResponse,
  type ListOptions,
  type UpdateSessionRequest
} from '@types'
import { and, asc, count, desc, eq, inArray, like, or, type SQL, sql } from 'drizzle-orm'
import { app } from 'electron'

import { BaseService } from '../BaseService'
import {
  agentsTable,
  type InsertSessionRow,
  type SessionMessageRow,
  sessionMessagesTable,
  type SessionRow,
  sessionsTable
} from '../database/schema'
import type { AgentModelField } from '../errors'
import { builtinSlashCommands } from './claudecode/commands'
import { haveSameAccessiblePaths } from './sessionWorkspace'

const logger = loggerService.withContext('SessionService')

const SDK_SLASH_COMMAND_DESCRIPTIONS = {
  'en-US': {
    '/batch': 'Run a batch-style workflow for repeated tasks',
    '/cherry-assistant-guide': 'Open the built-in product guide, troubleshooting notes, and page navigation hints',
    '/claude-api': 'Inspect or explain Claude/API-related usage and configuration',
    '/clear': 'Clear the current conversation context',
    '/compact': 'Compress the conversation and keep only the most useful context',
    '/context': 'Show current context usage and remaining room',
    '/cost': 'Show token and cost usage for the current session',
    '/debug': 'Collect extra debugging context for troubleshooting',
    '/faq-collector': 'Save a solved problem into the FAQ knowledge file',
    '/find-skills': 'Search for installable skills that extend the agent',
    '/heapdump': 'Collect runtime memory diagnostics for advanced debugging',
    '/init': 'Initialize the current workspace for agent usage',
    '/insights': 'Summarize useful insights from the current work context',
    '/issue-reporter': 'Draft or file a bug report or feature request',
    '/loop': 'Run a multi-step loop until the task reaches a stopping condition',
    '/mcp__exa__web_search_help': 'Show help for Exa web search capabilities',
    '/pr-comments': 'Generate or summarize pull request comments',
    '/release-notes': 'Draft release notes from recent changes',
    '/review': 'Review code or changes and surface risks',
    '/security-review': 'Review code or changes from a security perspective',
    '/simplify': 'Rewrite the plan or answer in a simpler form',
    '/skill-creator': 'Create or improve a reusable skill',
    '/skills-manager': 'Search, install, or manage agent skills',
    '/todos': 'Show the current task checklist'
  },
  'zh-CN': {
    '/batch': '执行一组批量化、重复性的任务流程',
    '/cherry-assistant-guide': '查看内置产品指南、故障排查说明和页面导航提示',
    '/claude-api': '查看或解释 Claude 与接口相关的配置和用法',
    '/clear': '清空当前会话上下文',
    '/compact': '压缩当前对话，只保留更有用的上下文',
    '/context': '查看当前上下文占用和剩余空间',
    '/cost': '查看当前会话的 Token 与成本消耗',
    '/debug': '收集额外的调试信息用于排查问题',
    '/faq-collector': '把已经解决的问题收录到 FAQ 知识文件',
    '/find-skills': '搜索可安装的技能来扩展 Agent 能力',
    '/heapdump': '收集运行时内存诊断信息，适合高级排障',
    '/init': '初始化当前工作区的 Agent 使用环境',
    '/insights': '基于当前上下文提炼重点洞察',
    '/issue-reporter': '整理并提交 Bug 反馈或功能需求',
    '/loop': '按循环流程连续执行多步任务直到满足停止条件',
    '/mcp__exa__web_search_help': '查看 Exa 网页搜索能力的帮助说明',
    '/pr-comments': '生成或整理 Pull Request 评论',
    '/release-notes': '根据近期变更整理更新说明',
    '/review': '对代码或改动做审查并指出风险',
    '/security-review': '从安全角度审查代码或改动',
    '/simplify': '把当前方案或回答改写得更简单易懂',
    '/skill-creator': '创建或改进一个可复用的 Skill',
    '/skills-manager': '搜索、安装或管理 Agent Skills',
    '/todos': '查看当前任务清单'
  }
} as const

export class SessionService extends BaseService {
  private static instance: SessionService | null = null
  private readonly modelFields: AgentModelField[] = ['model', 'plan_model', 'small_model']

  static getInstance(): SessionService {
    if (!SessionService.instance) {
      SessionService.instance = new SessionService()
    }
    return SessionService.instance
  }

  private escapeLikeQuery(value: string): string {
    return `%${value.replace(/([\\%_])/g, '\\$1')}%`
  }

  private getSlashCommandLocale(): 'en-US' | 'zh-CN' {
    return configManager.getLanguage() === 'zh-CN' ? 'zh-CN' : 'en-US'
  }

  private async repairAgentAccessiblePaths(
    database: Awaited<ReturnType<SessionService['getDatabase']>>,
    agent: AgentEntity
  ): Promise<AgentEntity> {
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

  private async repairSessionAccessiblePaths(
    database: Awaited<ReturnType<SessionService['getDatabase']>>,
    session: GetAgentSessionResponse
  ): Promise<GetAgentSessionResponse> {
    const reconciled = this.reconcileAccessiblePaths(session.accessible_paths, session.agent_id)
    if (!reconciled.changed) {
      return session
    }

    await database
      .update(sessionsTable)
      .set({
        accessible_paths: this.serializeJsonFields({ accessible_paths: reconciled.paths }).accessible_paths,
        updated_at: new Date().toISOString()
      })
      .where(eq(sessionsTable.id, session.id))

    return {
      ...session,
      accessible_paths: reconciled.paths
    }
  }

  private normalizeSlashCommandEntry(command: SlashCommand | string | null | undefined): SlashCommand | null {
    if (!command) {
      return null
    }

    if (typeof command === 'string') {
      const normalizedCommand = command.startsWith('/') ? command : `/${command}`
      return { command: normalizedCommand }
    }

    if (typeof command.command !== 'string' || !command.command.trim()) {
      return null
    }

    return {
      command: command.command.startsWith('/') ? command.command : `/${command.command}`,
      description: command.description
    }
  }

  private mergeSlashCommand(
    commandMap: Map<string, SlashCommand>,
    command: SlashCommand | string | null | undefined,
    preferredDescriptions?: Record<string, string>
  ) {
    const normalized = this.normalizeSlashCommandEntry(command)
    if (!normalized) {
      return
    }

    const preferredDescription = preferredDescriptions?.[normalized.command]
    const existing = commandMap.get(normalized.command)
    const description = preferredDescription ?? normalized.description ?? existing?.description

    if (!existing) {
      commandMap.set(normalized.command, {
        command: normalized.command,
        ...(description ? { description } : {})
      })
      return
    }

    if (!existing.description && description) {
      commandMap.set(normalized.command, {
        command: normalized.command,
        description
      })
    } else if (preferredDescription && existing.description !== preferredDescription) {
      commandMap.set(normalized.command, {
        command: normalized.command,
        description: preferredDescription
      })
    }
  }

  private getKnownSlashCommandDescriptions() {
    return SDK_SLASH_COMMAND_DESCRIPTIONS[this.getSlashCommandLocale()]
  }

  private async getAgentWorkspacePath(agentId?: string): Promise<string | undefined> {
    if (!agentId) {
      return undefined
    }

    const database = await this.getDatabase()
    const result = await database.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1)
    const rawAgent = result[0] ? (this.deserializeJsonFields(result[0]) as AgentEntity) : null
    const agent = rawAgent ? await this.repairAgentAccessiblePaths(database, rawAgent) : null
    return agent?.accessible_paths?.[0]
  }

  private async collectSkillSlashCommands(skillsDir: string, sourcePrefix: string): Promise<SlashCommand[]> {
    const commands: SlashCommand[] = []

    try {
      const entries = await fs.promises.readdir(skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        try {
          const skillPath = path.join(skillsDir, entry.name)
          const metadata = await parseSkillMetadata(skillPath, path.join(sourcePrefix, entry.name), 'skills')
          commands.push({
            command: `/${entry.name}`,
            description: metadata.description
          })
        } catch {
          // Skip skills with invalid metadata
        }
      }
    } catch {
      // Skill directory doesn't exist, that's fine
    }

    return commands
  }

  private async getSupplementalSlashCommands(agentId?: string): Promise<SlashCommand[]> {
    const commands: SlashCommand[] = []

    const workspacePath = await this.getAgentWorkspacePath(agentId)
    if (workspacePath) {
      commands.push(...(await this.collectSkillSlashCommands(path.join(workspacePath, '.claude', 'skills'), 'skills')))
    }

    const globalSkillsDir = toAsarUnpackedPath(path.join(app.getAppPath(), 'resources', 'skills'))
    commands.push(...(await this.collectSkillSlashCommands(globalSkillsDir, 'skills')))

    return commands
  }

  async enrichSlashCommands(
    commands: Array<SlashCommand | string>,
    agentType: string,
    agentId?: string
  ): Promise<SlashCommand[]> {
    const commandMap = new Map<string, SlashCommand>()
    const knownDescriptions = this.getKnownSlashCommandDescriptions()

    for (const command of commands) {
      this.mergeSlashCommand(commandMap, command, knownDescriptions)
    }

    const supplementalCommands = await this.listSlashCommands(agentType, agentId)
    for (const command of supplementalCommands) {
      this.mergeSlashCommand(commandMap, command, knownDescriptions)
    }

    return Array.from(commandMap.values())
  }

  private hydrateStoredSlashCommands(commands: Array<SlashCommand | string>): SlashCommand[] {
    const commandMap = new Map<string, SlashCommand>()
    const knownDescriptions = this.getKnownSlashCommandDescriptions()

    for (const command of commands) {
      this.mergeSlashCommand(commandMap, command, knownDescriptions)
    }

    return Array.from(commandMap.values())
  }

  private appendArchivedFilter(whereConditions: SQL[], archived: ListOptions['archived'] = 'exclude') {
    if (archived === 'only') {
      whereConditions.push(eq(sessionsTable.is_archived, true))
      return
    }

    if (archived !== 'include') {
      whereConditions.push(eq(sessionsTable.is_archived, false))
    }
  }

  private buildSessionOrder(options: ListOptions = {}) {
    const sortBy = options.sortBy ?? 'updated_at'
    const orderBy = options.orderBy ?? 'desc'
    const sortDirection = orderBy === 'asc' ? asc : desc
    const orderClauses = [desc(sessionsTable.is_pinned)]

    switch (sortBy) {
      case 'name':
        orderClauses.push(sortDirection(sessionsTable.name), desc(sessionsTable.updated_at))
        break
      case 'created_at':
        orderClauses.push(sortDirection(sessionsTable.created_at), desc(sessionsTable.updated_at))
        break
      case 'sort_order':
        orderClauses.push(asc(sessionsTable.sort_order), desc(sessionsTable.updated_at))
        break
      case 'updated_at':
      default:
        orderClauses.push(sortDirection(sessionsTable.updated_at), desc(sessionsTable.created_at))
        break
    }

    return orderClauses
  }

  private extractSearchableText(value: unknown): string[] {
    if (!value) {
      return []
    }

    if (typeof value === 'string') {
      return [value]
    }

    if (Array.isArray(value)) {
      return value.flatMap((item) => this.extractSearchableText(item))
    }

    if (typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (Array.isArray(record.blocks)) {
        const blockContents = record.blocks
          .map((block) => (block && typeof block === 'object' ? (block as Record<string, unknown>).content : undefined))
          .filter((content): content is string => typeof content === 'string')

        if (blockContents.length > 0) {
          return blockContents
        }
      }

      return Object.entries(record).flatMap(([key, entry]) => {
        if (typeof entry === 'string' && ['content', 'text', 'title', 'name'].includes(key)) {
          return [entry]
        }

        return this.extractSearchableText(entry)
      })
    }

    return []
  }

  private buildSnippet(text: string, query: string): string {
    const normalizedText = text.replace(/\s+/g, ' ').trim()
    if (!normalizedText) {
      return ''
    }

    const loweredText = normalizedText.toLowerCase()
    const loweredQuery = query.trim().toLowerCase()
    const matchIndex = loweredQuery ? loweredText.indexOf(loweredQuery) : -1

    if (matchIndex === -1) {
      return normalizedText.length > 140 ? `${normalizedText.slice(0, 140)}...` : normalizedText
    }

    const start = Math.max(0, matchIndex - 48)
    const end = Math.min(normalizedText.length, matchIndex + loweredQuery.length + 92)
    const prefix = start > 0 ? '...' : ''
    const suffix = end < normalizedText.length ? '...' : ''

    return `${prefix}${normalizedText.slice(start, end)}${suffix}`
  }

  private async buildSessionSearchMatch(sessionId: string, escapedQuery: string, query: string) {
    const database = await this.getDatabase()
    const rows = await database
      .select({
        content: sessionMessagesTable.content,
        created_at: sessionMessagesTable.created_at
      })
      .from(sessionMessagesTable)
      .where(and(eq(sessionMessagesTable.session_id, sessionId), like(sessionMessagesTable.content, escapedQuery)))
      .orderBy(desc(sessionMessagesTable.created_at))
      .limit(5)

    for (const row of rows as Pick<SessionMessageRow, 'content' | 'created_at'>[]) {
      try {
        const parsed = JSON.parse(row.content)
        const texts = this.extractSearchableText(parsed)
        const matched = texts.find((item) => item.toLowerCase().includes(query.toLowerCase()))
        if (matched) {
          return {
            snippet: this.buildSnippet(matched, query),
            matched_at: row.created_at
          }
        }
      } catch {
        const matched = row.content.toLowerCase().includes(query.toLowerCase()) ? row.content : undefined
        if (matched) {
          return {
            snippet: this.buildSnippet(matched, query),
            matched_at: row.created_at
          }
        }
      }
    }

    return {}
  }

  /**
   * Override BaseService.listSlashCommands to merge builtin and plugin commands
   */
  async listSlashCommands(agentType: string, agentId?: string): Promise<SlashCommand[]> {
    const commandMap = new Map<string, SlashCommand>()
    const knownDescriptions = this.getKnownSlashCommandDescriptions()

    // Add builtin slash commands
    if (agentType === 'claude-code') {
      for (const command of builtinSlashCommands) {
        this.mergeSlashCommand(commandMap, command, knownDescriptions)
      }
    }

    // Add local command plugins from .claude/commands/
    const workspacePath = await this.getAgentWorkspacePath(agentId)
    if (workspacePath) {
      try {
        const commandsDir = path.join(workspacePath, '.claude', 'commands')
        try {
          const entries = await fs.promises.readdir(commandsDir, { withFileTypes: true })
          const ALLOWED_EXTENSIONS = ['.md', '.txt']
          let localCount = 0

          for (const entry of entries) {
            if (!entry.isFile()) continue
            const ext = path.extname(entry.name).toLowerCase()
            if (!ALLOWED_EXTENSIONS.includes(ext)) continue

            try {
              const filePath = path.join(commandsDir, entry.name)
              const metadata = await parsePluginMetadata(
                filePath,
                path.join('commands', entry.name),
                'commands',
                'command'
              )
              const commandName = entry.name.replace(/\.(md|txt)$/i, '')
              this.mergeSlashCommand(
                commandMap,
                {
                  command: `/${commandName}`,
                  description: metadata.description
                },
                knownDescriptions
              )
              localCount++
            } catch {
              // Skip files that fail to parse
            }
          }

          logger.info('Listed slash commands', {
            agentType,
            agentId,
            builtinCount: builtinSlashCommands.length,
            localCount,
            totalCount: commandMap.size
          })
        } catch {
          // .claude/commands/ doesn't exist, that's fine
        }
      } catch (error) {
        logger.warn('Failed to list local command plugins', {
          agentId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    const supplementalCommands = await this.getSupplementalSlashCommands(agentId)
    for (const command of supplementalCommands) {
      this.mergeSlashCommand(commandMap, command, knownDescriptions)
    }

    return Array.from(commandMap.values())
  }

  async createSession(
    agentId: string,
    req: Partial<CreateSessionRequest> = {}
  ): Promise<GetAgentSessionResponse | null> {
    // Validate agent exists - we'll need to import AgentService for this check
    // For now, we'll skip this validation to avoid circular dependencies
    // The database foreign key constraint will handle this

    const database = await this.getDatabase()
    const agents = await database.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1)
    if (!agents[0]) {
      throw new Error('Agent not found')
    }
    const rawAgent = this.deserializeJsonFields(agents[0]) as AgentEntity
    const agent = await this.repairAgentAccessiblePaths(database, rawAgent)

    const id = `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    const now = new Date().toISOString()

    // inherit configuration from agent by default, can be overridden by sessionData
    const sessionData: Partial<CreateSessionRequest> = {
      ...agent,
      ...req
    }

    await this.validateAgentModels(agent.type, {
      model: sessionData.model,
      plan_model: sessionData.plan_model,
      small_model: sessionData.small_model
    })

    if (sessionData.accessible_paths !== undefined) {
      sessionData.accessible_paths = this.ensurePathsExist(sessionData.accessible_paths)
    }

    const serializedData = this.serializeJsonFields(sessionData)

    const insertData: InsertSessionRow = {
      id,
      agent_id: agentId,
      agent_type: agent.type,
      name: serializedData.name || null,
      description: serializedData.description || null,
      accessible_paths: serializedData.accessible_paths || null,
      instructions: serializedData.instructions || null,
      model: serializedData.model || null,
      plan_model: serializedData.plan_model || null,
      small_model: serializedData.small_model || null,
      mcps: serializedData.mcps || null,
      allowed_tools: serializedData.allowed_tools || null,
      configuration: serializedData.configuration || null,
      sort_order: 0,
      is_pinned: false,
      is_archived: false,
      created_at: now,
      updated_at: now
    }

    const db = await this.getDatabase()
    // Shift all existing sessions' sort_order up by 1 and insert new session at position 0 atomically
    await db.transaction(async (tx) => {
      await tx
        .update(sessionsTable)
        .set({ sort_order: sql`${sessionsTable.sort_order} + 1` })
        .where(eq(sessionsTable.agent_id, agentId))
      await tx.insert(sessionsTable).values(insertData)
    })

    const result = await db.select().from(sessionsTable).where(eq(sessionsTable.id, id)).limit(1)

    if (!result[0]) {
      throw new Error('Failed to create session')
    }

    const session = this.deserializeJsonFields(result[0])
    return await this.getSession(agentId, session.id)
  }

  async getSession(agentId: string, id: string): Promise<GetAgentSessionResponse | null> {
    const database = await this.getDatabase()
    const result = await database
      .select()
      .from(sessionsTable)
      .where(and(eq(sessionsTable.id, id), eq(sessionsTable.agent_id, agentId)))
      .limit(1)

    if (!result[0]) {
      return null
    }

    let session = this.deserializeJsonFields(result[0]) as GetAgentSessionResponse
    session = await this.repairSessionAccessiblePaths(database, session)
    const { tools, legacyIdMap } = await this.listMcpTools(session.agent_type, session.mcps)
    session.tools = tools
    session.allowed_tools = this.normalizeAllowedTools(session.allowed_tools, session.tools, legacyIdMap)

    const originalSlashCommands = Array.isArray(session.slash_commands) ? session.slash_commands : []

    // If slash_commands is not in database yet (e.g., first invoke before init message),
    // fall back to builtin + local commands. Otherwise, use the merged commands from database.
    const enrichedSlashCommands =
      originalSlashCommands.length === 0
        ? await this.listSlashCommands(session.agent_type, agentId)
        : this.hydrateStoredSlashCommands(originalSlashCommands)

    session.slash_commands = enrichedSlashCommands

    const originalSerialized = JSON.stringify(originalSlashCommands)
    const enrichedSerialized = JSON.stringify(enrichedSlashCommands)
    if (originalSerialized !== enrichedSerialized) {
      await database
        .update(sessionsTable)
        .set({
          slash_commands: enrichedSerialized
        })
        .where(and(eq(sessionsTable.id, id), eq(sessionsTable.agent_id, agentId)))
    }

    return session
  }

  async listSessions(
    agentId?: string,
    options: ListOptions = {}
  ): Promise<{ sessions: AgentSessionEntity[]; total: number }> {
    // Build where conditions
    const whereConditions: SQL[] = []
    if (agentId) {
      whereConditions.push(eq(sessionsTable.agent_id, agentId))
    }
    this.appendArchivedFilter(whereConditions, options.archived)

    if (options.search?.trim()) {
      const escapedQuery = this.escapeLikeQuery(options.search.trim())
      whereConditions.push(
        or(
          like(sessionsTable.name, escapedQuery),
          sql`exists (
            select 1
            from ${sessionMessagesTable}
            where ${sessionMessagesTable.session_id} = ${sessionsTable.id}
              and ${sessionMessagesTable.content} like ${escapedQuery}
          )`
        )!
      )
    }

    const whereClause =
      whereConditions.length > 1
        ? and(...whereConditions)
        : whereConditions.length === 1
          ? whereConditions[0]
          : undefined

    // Get total count
    const database = await this.getDatabase()
    const totalResult = await database.select({ count: count() }).from(sessionsTable).where(whereClause)

    const total = totalResult[0].count

    // Build list query with pagination - sort by sort_order ASC, created_at DESC for tie-breaking
    const baseQuery = database
      .select()
      .from(sessionsTable)
      .where(whereClause)
      .orderBy(...this.buildSessionOrder(options))

    const result =
      options.limit !== undefined
        ? options.offset !== undefined
          ? await baseQuery.limit(options.limit).offset(options.offset)
          : await baseQuery.limit(options.limit)
        : await baseQuery

    const sessions = await Promise.all(
      result.map(async (row) => {
        const session = this.deserializeJsonFields(row) as GetAgentSessionResponse
        return this.repairSessionAccessiblePaths(database, session)
      })
    )

    await Promise.all(
      sessions.map(async (session) => {
        const { tools, legacyIdMap } = await this.listMcpTools(session.agent_type, session.mcps)
        session.tools = tools
        session.allowed_tools = this.normalizeAllowedTools(session.allowed_tools, session.tools, legacyIdMap)
      })
    )

    return { sessions, total }
  }

  async searchSessions(
    query: string,
    options: ListOptions = {}
  ): Promise<{
    results: Array<{ session: AgentSessionEntity; snippet?: string; matched_at?: string }>
    total: number
  }> {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) {
      return { results: [], total: 0 }
    }

    const escapedQuery = this.escapeLikeQuery(trimmedQuery)
    const result = await this.listSessions(undefined, {
      ...options,
      archived: options.archived ?? 'include',
      search: trimmedQuery,
      sortBy: 'updated_at',
      orderBy: 'desc'
    })

    const sessions = result.sessions
    const results = await Promise.all(
      sessions.map(async (session) => {
        if (session.name?.toLowerCase().includes(trimmedQuery.toLowerCase())) {
          return {
            session,
            snippet: this.buildSnippet(session.name, trimmedQuery),
            matched_at: session.updated_at
          }
        }

        const match = await this.buildSessionSearchMatch(session.id, escapedQuery, trimmedQuery)
        return {
          session,
          ...match
        }
      })
    )

    return { results, total: result.total }
  }

  async updateSession(
    agentId: string,
    id: string,
    updates: UpdateSessionRequest
  ): Promise<UpdateSessionResponse | null> {
    // Check if session exists
    const existing = await this.getSession(agentId, id)
    if (!existing) {
      return null
    }

    // Validate agent exists if changing main_agent_id
    // We'll skip this validation for now to avoid circular dependencies

    const now = new Date().toISOString()

    if (updates.accessible_paths !== undefined) {
      if (updates.accessible_paths.length === 0) {
        throw new Error('accessible_paths must not be empty')
      }
      updates.accessible_paths = this.resolveAccessiblePaths(updates.accessible_paths, existing.agent_id)
    }

    const modelUpdates: Partial<Record<AgentModelField, string | undefined>> = {}
    for (const field of this.modelFields) {
      if (Object.prototype.hasOwnProperty.call(updates, field)) {
        modelUpdates[field] = updates[field as keyof UpdateSessionRequest] as string | undefined
      }
    }

    if (Object.keys(modelUpdates).length > 0) {
      await this.validateAgentModels(existing.agent_type, modelUpdates)
    }

    const serializedUpdates = this.serializeJsonFields(updates)

    const updateData: Partial<SessionRow> = {
      updated_at: now
    }
    const replaceableFields = Object.keys(AgentBaseSchema.shape) as (keyof SessionRow)[]

    for (const field of replaceableFields) {
      if (Object.prototype.hasOwnProperty.call(serializedUpdates, field)) {
        const value = serializedUpdates[field as keyof typeof serializedUpdates]
        ;(updateData as Record<string, unknown>)[field] = value ?? null
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'is_pinned')) {
      updateData.is_pinned = updates.is_pinned ?? false
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'is_archived')) {
      updateData.is_archived = updates.is_archived ?? false
    }

    const database = await this.getDatabase()
    await database.update(sessionsTable).set(updateData).where(eq(sessionsTable.id, id))

    return await this.getSession(agentId, id)
  }

  async syncAgentSessionInstructions(agentId: string, instructions: string): Promise<number> {
    const database = await this.getDatabase()
    const result = await database
      .update(sessionsTable)
      .set({
        instructions
      })
      .where(eq(sessionsTable.agent_id, agentId))

    logger.info('Synchronized session instructions for agent', {
      agentId,
      updated: result.rowsAffected
    })

    return result.rowsAffected
  }

  async syncAgentSessionConfiguration(agentId: string, configuration: AgentEntity['configuration']): Promise<number> {
    const database = await this.getDatabase()
    const serialized = this.serializeJsonFields({ configuration })
    const result = await database
      .update(sessionsTable)
      .set({
        configuration: serialized.configuration ?? null,
        updated_at: new Date().toISOString()
      })
      .where(eq(sessionsTable.agent_id, agentId))

    logger.info('Synchronized session configuration for agent', {
      agentId,
      updated: result.rowsAffected
    })

    return result.rowsAffected
  }

  async syncInheritedAgentSessionAccessiblePaths(
    agentId: string,
    previousPaths: string[],
    accessiblePaths: string[]
  ): Promise<number> {
    const database = await this.getDatabase()
    const rows = await database
      .select({
        id: sessionsTable.id,
        accessible_paths: sessionsTable.accessible_paths
      })
      .from(sessionsTable)
      .where(eq(sessionsTable.agent_id, agentId))

    const inheritedSessionIds = rows
      .filter((row) => {
        const session = this.deserializeJsonFields(row) as Pick<AgentSessionEntity, 'accessible_paths'>
        return haveSameAccessiblePaths(session.accessible_paths, previousPaths)
      })
      .map((row) => row.id)

    if (inheritedSessionIds.length === 0) {
      return 0
    }

    const serialized = this.serializeJsonFields({ accessible_paths: accessiblePaths })
    const result = await database
      .update(sessionsTable)
      .set({
        accessible_paths: serialized.accessible_paths ?? null,
        updated_at: new Date().toISOString()
      })
      .where(and(eq(sessionsTable.agent_id, agentId), inArray(sessionsTable.id, inheritedSessionIds)))

    logger.info('Synchronized inherited session workspaces for agent', {
      agentId,
      updated: result.rowsAffected
    })

    return result.rowsAffected
  }

  async deleteSession(agentId: string, id: string): Promise<boolean> {
    const database = await this.getDatabase()
    const result = await database
      .delete(sessionsTable)
      .where(and(eq(sessionsTable.id, id), eq(sessionsTable.agent_id, agentId)))

    return result.rowsAffected > 0
  }

  async deleteEmptySessionsForAgents(agentIds: string[]): Promise<number> {
    if (agentIds.length === 0) {
      return 0
    }

    const database = await this.getDatabase()
    const result = await database.delete(sessionsTable).where(
      and(
        inArray(sessionsTable.agent_id, agentIds),
        sql`not exists (
            select 1
            from ${sessionMessagesTable}
            where ${sessionMessagesTable.session_id} = ${sessionsTable.id}
          )`
      )
    )

    if (result.rowsAffected > 0) {
      logger.info('Deleted empty sessions for legacy built-in agents', {
        agentIds,
        deleted: result.rowsAffected
      })
    }

    return result.rowsAffected
  }

  async reorderSessions(agentId: string, orderedIds: string[]): Promise<void> {
    const database = await this.getDatabase()
    await database.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx
          .update(sessionsTable)
          .set({ sort_order: i })
          .where(and(eq(sessionsTable.id, orderedIds[i]), eq(sessionsTable.agent_id, agentId)))
      }
    })
    logger.info('Sessions reordered', { agentId, count: orderedIds.length })
  }

  async sessionExists(agentId: string, id: string): Promise<boolean> {
    const database = await this.getDatabase()
    const result = await database
      .select({ id: sessionsTable.id })
      .from(sessionsTable)
      .where(and(eq(sessionsTable.id, id), eq(sessionsTable.agent_id, agentId)))
      .limit(1)

    return result.length > 0
  }
}

export const sessionService = SessionService.getInstance()
