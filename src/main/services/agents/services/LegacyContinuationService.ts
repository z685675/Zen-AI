import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { modelsService } from '@main/apiServer/services/models'
import { validateModelId } from '@main/apiServer/utils'
import { configManager } from '@main/services/ConfigManager'
import { remoteModelPolicyService } from '@main/services/RemoteModelPolicyService'
import { getDataPath } from '@main/utils'
import { DEFAULT_OPENCODE_AGENT_ID } from '@shared/config/agents'
import { AgentConfigurationSchema, type GetAgentSessionResponse, type LegacyContinuationResponse } from '@types'
import { and, asc, eq } from 'drizzle-orm'

import { resolveAssistantFallbackModel } from '../../../../renderer/src/config/agentModelPolicy'
import { BaseService } from '../BaseService'
import { sessionMessagesTable, sessionsTable } from '../database/schema'
import { ensureOpenCodeAgent } from './opencode/builtin'
import {
  buildContinuationContext,
  cloneContinuationHistory,
  continuationArchiveText,
  continuationError,
  continuationRecords,
  continuationRevision,
  copyContinuationAttachments,
  readContinuationHistory,
  seedContinuationMemory
} from './opencode/continuation'
import { acquireSessionActivity } from './sessionActivity'
import { sessionService } from './SessionService'

const logger = loggerService.withContext('LegacyContinuationService')

export class LegacyContinuationService extends BaseService {
  async continueSession(agentId: string, sourceId: string, signal: AbortSignal): Promise<LegacyContinuationResponse> {
    if (agentId === DEFAULT_OPENCODE_AGENT_ID) throw continuationError('continuation_not_legacy')
    const release = acquireSessionActivity(sourceId, 'continuation')
    let target: GetAgentSessionResponse | null = null
    let committed = false
    try {
      const database = await this.getDatabase()
      const readSource = async (db: typeof database) => {
        const [row] = await db
          .select()
          .from(sessionsTable)
          .where(and(eq(sessionsTable.id, sourceId), eq(sessionsTable.agent_id, agentId)))
          .limit(1)
        if (!row) throw continuationError('continuation_source_missing')
        const rows = await db
          .select()
          .from(sessionMessagesTable)
          .where(eq(sessionMessagesTable.session_id, sourceId))
          .orderBy(asc(sessionMessagesTable.created_at), asc(sessionMessagesTable.id))
        return { row, rows, revision: continuationRevision(row, rows) }
      }
      const source = await readSource(database)
      const history = readContinuationHistory(source.rows)
      const original = this.deserializeJsonFields(source.row) as GetAgentSessionResponse
      const paths = original.accessible_paths
      if (!Array.isArray(paths) || !paths.length) throw continuationError('continuation_workspace_missing')
      for (const root of paths) {
        if (!path.isAbsolute(root) || !(await fs.stat(root).catch(() => undefined))?.isDirectory())
          throw continuationError('continuation_workspace_missing')
      }
      // Durable idempotency survives a lost HTTP response and app restarts.
      const targets = await database
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.agent_id, DEFAULT_OPENCODE_AGENT_ID))
      for (const row of targets) {
        const candidate = this.deserializeJsonFields(row) as GetAgentSessionResponse
        const metadata = candidate.configuration?.legacy_continuation as Record<string, unknown> | undefined
        if (metadata?.source_session_id !== sourceId || metadata.source_revision !== source.revision) continue
        if (metadata.state === 'ready' && metadata.target_session_id === candidate.id && !candidate.is_archived) {
          const saved = await database
            .select({ id: sessionMessagesTable.id })
            .from(sessionMessagesTable)
            .where(eq(sessionMessagesTable.session_id, candidate.id))
            .limit(1)
          // Clearing the copy's conversation is an explicit discard, not a
          // successful snapshot to reuse on a later continuation request.
          if (saved.length) return { session: candidate, reused: true }
        }
        // An interrupted hidden preparation is never presented as a ready copy.
        if (metadata.state === 'preparing') await sessionService.deleteSession(DEFAULT_OPENCODE_AGENT_ID, candidate.id)
      }
      signal.throwIfAborted()
      if (!(await ensureOpenCodeAgent())) throw continuationError('continuation_no_model')
      const { data } = await modelsService.getModels({})
      const policy = remoteModelPolicyService.getSnapshot().policy
      const model = resolveAssistantFallbackModel(data, original.model, policy, configManager.getEnableDeveloperMode())
      if (!model) throw continuationError('continuation_no_model')
      const createdAt = new Date().toISOString()
      const metadata = {
        version: 1,
        state: 'preparing',
        source_agent_id: agentId,
        source_session_id: sourceId,
        source_name: original.name,
        source_revision: source.revision,
        created_at: createdAt,
        history_mode: 'local_excerpt',
        source_model: original.model
      }
      target = await sessionService.createSession(
        DEFAULT_OPENCODE_AGENT_ID,
        {
          name: original.name,
          model: model.id,
          accessible_paths: paths,
          instructions: '',
          mcps: [],
          allowed_tools: [],
          plan_model: undefined,
          small_model: undefined,
          // Do not inherit old SDK overrides, prompts, secrets, MCP, scheduler or approvals.
          configuration: {
            permission_mode: original.configuration?.permission_mode === 'plan' ? 'plan' : 'default',
            max_turns: 100,
            env_vars: {},
            assistant_engine: 'opencode',
            soul_enabled: false,
            scheduler_enabled: false,
            heartbeat_enabled: false,
            legacy_continuation: metadata
          }
        },
        { archived: true }
      )
      if (!target) throw continuationError('continuation_prepare_failed')
      // Use only the existing, user-confirmed workspace. Never provision or
      // overwrite skills/configuration inside the old workspace during transfer.
      const workspace = await fs.realpath(paths[0])
      let directory = workspace
      for (const part of ['.zen-ai', 'continuations', target.id]) {
        directory = path.join(directory, part)
        const entry = await fs.lstat(directory).catch((error) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        if (entry?.isSymbolicLink() || (entry && !entry.isDirectory()))
          throw continuationError('continuation_workspace_missing')
        if (!entry) await fs.mkdir(directory)
      }
      const items = cloneContinuationHistory(history, target.id, sourceId)
      const warnings = await copyContinuationAttachments(items, directory, paths, getDataPath('Files'))
      const structuredArchivePath = path.join(directory, 'history.json')
      await fs.writeFile(
        structuredArchivePath,
        JSON.stringify({
          version: 1,
          historical_data_only: true,
          source: sourceId,
          messages: continuationRecords(items)
        }),
        { encoding: 'utf8', flag: 'wx' }
      )
      const archivePath = path.join(directory, 'history.txt')
      await fs.writeFile(archivePath, continuationArchiveText(items), { encoding: 'utf8', flag: 'wx' })
      signal.throwIfAborted()
      const resolvedModel = await validateModelId(model.id)
      const configuredContext = resolvedModel.provider?.models.find(
        (entry) => entry.id === resolvedModel.modelId
      )?.contextWindowTokens
      const context = Number.isFinite(configuredContext) && configuredContext! > 0 ? configuredContext! : 128_000
      const contextChars = Math.min(24_000, Math.max(512, Math.floor(context / 2)))
      const nativeId = await seedContinuationMemory(
        target,
        buildContinuationContext(items, archivePath, contextChars),
        signal
      )
      const configuration = AgentConfigurationSchema.parse({
        ...target.configuration,
        legacy_continuation: {
          ...metadata,
          target_session_id: target.id,
          state: 'ready',
          archive_path: archivePath,
          structured_archive_path: structuredArchivePath,
          attachment_warnings: warnings,
          message_count: items.length,
          model_changed: model.id !== original.model
        }
      })
      await database.transaction(async (tx) => {
        signal.throwIfAborted()
        const current = await readSource(tx as unknown as typeof database)
        if (current.revision !== source.revision) throw continuationError('continuation_source_changed')
        for (const item of items) {
          await tx.insert(sessionMessagesTable).values({
            session_id: target!.id,
            role: item.message.role,
            content: JSON.stringify(item),
            agent_session_id: '',
            created_at: item.message.createdAt,
            updated_at: createdAt
          })
        }
        await tx
          .update(sessionsTable)
          .set({ configuration: JSON.stringify(configuration), is_archived: false })
          .where(eq(sessionsTable.id, target!.id))
      })
      committed = true
      logger.info('Legacy conversation continued as an independent snapshot', {
        sourceId,
        targetId: target.id,
        messages: items.length,
        attachmentsUnavailable: warnings.length,
        nativeId
      })
      return { session: { ...target, configuration, is_archived: false }, reused: false }
    } catch (error) {
      if (target && !committed) {
        try {
          await sessionService.deleteSession(DEFAULT_OPENCODE_AGENT_ID, target.id)
        } catch (cleanupError) {
          logger.warn('Hidden continuation preparation retained for recovery', {
            targetId: target.id,
            error: cleanupError
          })
        }
      }
      throw error
    } finally {
      release()
    }
  }
}

export const legacyContinuationService = new LegacyContinuationService()
