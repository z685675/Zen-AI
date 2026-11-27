import { randomUUID } from 'node:crypto'

import { loggerService } from '@logger'
import { assertAssistantExecutionAllowed } from '@shared/agents/assistantAvailability'
import { DEFAULT_DSH_AGENT_ID, isNewAssistantAgentId } from '@shared/config/agents'
import type {
  AgentMessageAssistantPersistPayload,
  AgentMessagePersistExchangePayload,
  AgentMessagePersistExchangeResult,
  AgentMessageUserPersistPayload,
  AgentPersistedMessage,
  AgentSessionMessageEntity
} from '@types'
import { and, asc, eq, sql } from 'drizzle-orm'

import { assertDshPreviewUnlocked } from '../../dshPreview/access'
import { BaseService } from '../BaseService'
import { repairInterruptedHistory } from '../services/interruptedHistory'
import { hasSessionActivity } from '../services/sessionActivity'
import type { InsertSessionMessageRow, SessionMessageRow } from './schema'
import { sessionMessagesTable, sessionsTable } from './schema'

const logger = loggerService.withContext('AgentMessageRepository')
const applicationStartedAt = Date.now()
const applicationRunId = randomUUID()

export type PersistUserMessageParams = AgentMessageUserPersistPayload & {
  sessionId: string
  agentSessionId?: string
}

export type PersistAssistantMessageParams = AgentMessageAssistantPersistPayload & {
  sessionId: string
  agentSessionId: string
}

class AgentMessageRepository extends BaseService {
  private static instance: AgentMessageRepository | null = null

  static getInstance(): AgentMessageRepository {
    if (!AgentMessageRepository.instance) {
      AgentMessageRepository.instance = new AgentMessageRepository()
    }

    return AgentMessageRepository.instance
  }

  private async assertSessionAccess(sessionId: string, activeAssistantOnly = false): Promise<void> {
    // IPC carries a session ID and untrusted message payloads. Authorization
    // follows the stored owner, never a renderer-supplied assistantId.
    const database = await this.getDatabase()
    const [session] = await database
      .select({ agentId: sessionsTable.agent_id })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId))
      .limit(1)
    if (activeAssistantOnly) assertAssistantExecutionAllowed(session?.agentId)
    if (session?.agentId === DEFAULT_DSH_AGENT_ID) assertDshPreviewUnlocked()
  }

  private serializeMessage(payload: AgentPersistedMessage): string {
    return JSON.stringify(payload)
  }

  private serializeMetadata(metadata?: Record<string, unknown>): string | undefined {
    if (!metadata) {
      return undefined
    }

    try {
      return JSON.stringify(metadata)
    } catch (error) {
      logger.warn('Failed to serialize session message metadata', error as Error)
      return undefined
    }
  }

  private deserialize(row: any): AgentSessionMessageEntity {
    if (!row) return row

    const deserialized = { ...row }

    if (typeof deserialized.content === 'string') {
      try {
        deserialized.content = JSON.parse(deserialized.content)
      } catch (error) {
        logger.warn('Failed to parse session message content JSON', error as Error)
      }
    }

    if (typeof deserialized.metadata === 'string') {
      try {
        deserialized.metadata = JSON.parse(deserialized.metadata)
      } catch (error) {
        logger.warn('Failed to parse session message metadata JSON', error as Error)
      }
    }

    return deserialized
  }

  private async findExistingMessageRow(
    sessionId: string,
    role: string,
    messageId: string
  ): Promise<SessionMessageRow | null> {
    const database = await this.getDatabase()
    // Use SQLite json_extract to query by messageId directly, avoiding loading all messages
    const rows = await database
      .select()
      .from(sessionMessagesTable)
      .where(
        and(
          eq(sessionMessagesTable.session_id, sessionId),
          eq(sessionMessagesTable.role, role),
          sql`json_extract(${sessionMessagesTable.content}, '$.message.id') = ${messageId}`
        )
      )
      .limit(1)

    return rows[0] ?? null
  }

  private async upsertMessage(
    params: PersistUserMessageParams | PersistAssistantMessageParams
  ): Promise<AgentSessionMessageEntity> {
    const { sessionId, agentSessionId = '', payload, metadata, createdAt } = params
    await this.assertSessionAccess(sessionId)

    if (!payload?.message?.role) {
      throw new Error('Message payload missing role')
    }

    if (!payload.message.id) {
      throw new Error('Message payload missing id')
    }

    const database = await this.getDatabase()
    const now = createdAt ?? payload.message.createdAt ?? new Date().toISOString()
    // Provenance, not a new DB field. Fresh pending messages must not be mistaken
    // for abandoned history when the machine's wall clock changes.
    const serializedPayload = this.serializeMessage(
      isNewAssistantAgentId(payload.message.assistantId) && payload.message.role === 'assistant'
        ? {
            ...payload,
            message: {
              ...payload.message,
              providerMetadata: { ...payload.message.providerMetadata, zenAppRun: { id: applicationRunId } }
            }
          }
        : payload
    )
    const serializedMetadata = this.serializeMetadata(metadata)

    const existingRow = await this.findExistingMessageRow(sessionId, payload.message.role, payload.message.id)

    if (existingRow) {
      const metadataToPersist = serializedMetadata ?? existingRow.metadata ?? undefined
      const agentSessionToPersist = agentSessionId || existingRow.agent_session_id || ''

      await database
        .update(sessionMessagesTable)
        .set({
          content: serializedPayload,
          metadata: metadataToPersist,
          agent_session_id: agentSessionToPersist,
          updated_at: now
        })
        .where(eq(sessionMessagesTable.id, existingRow.id))

      return this.deserialize({
        ...existingRow,
        content: serializedPayload,
        metadata: metadataToPersist,
        agent_session_id: agentSessionToPersist,
        updated_at: now
      })
    }

    const insertData: InsertSessionMessageRow = {
      session_id: sessionId,
      role: payload.message.role,
      content: serializedPayload,
      agent_session_id: agentSessionId,
      metadata: serializedMetadata,
      created_at: now,
      updated_at: now
    }

    const [saved] = await database.insert(sessionMessagesTable).values(insertData).returning()

    return this.deserialize(saved)
  }

  async persistUserMessage(params: PersistUserMessageParams): Promise<AgentSessionMessageEntity> {
    return this.upsertMessage({ ...params, agentSessionId: params.agentSessionId ?? '' })
  }

  async persistAssistantMessage(params: PersistAssistantMessageParams): Promise<AgentSessionMessageEntity> {
    return this.upsertMessage(params)
  }

  async persistExchange(
    params: AgentMessagePersistExchangePayload,
    activeAssistantOnly = false
  ): Promise<AgentMessagePersistExchangeResult> {
    const { sessionId, agentSessionId, user, assistant } = params
    if (activeAssistantOnly) await this.assertSessionAccess(sessionId, true)

    const exchangeResult: AgentMessagePersistExchangeResult = {}

    if (user?.payload) {
      exchangeResult.userMessage = await this.persistUserMessage({
        sessionId,
        agentSessionId,
        payload: user.payload,
        metadata: user.metadata,
        createdAt: user.createdAt
      })
    }

    if (assistant?.payload) {
      exchangeResult.assistantMessage = await this.persistAssistantMessage({
        sessionId,
        agentSessionId,
        payload: assistant.payload,
        metadata: assistant.metadata,
        createdAt: assistant.createdAt
      })
    }

    return exchangeResult
  }

  async getSessionHistory(sessionId: string): Promise<AgentPersistedMessage[]> {
    try {
      await this.assertSessionAccess(sessionId)
      const database = await this.getDatabase()
      const rows = await database
        .select()
        .from(sessionMessagesTable)
        .where(eq(sessionMessagesTable.session_id, sessionId))
        .orderBy(asc(sessionMessagesTable.created_at))

      const messages: AgentPersistedMessage[] = []

      for (const row of rows) {
        const deserialized = this.deserialize(row)
        if (deserialized?.content) {
          const original = deserialized.content as AgentPersistedMessage
          const repaired =
            isNewAssistantAgentId(original.message?.assistantId) && !hasSessionActivity(sessionId)
              ? repairInterruptedHistory(original, applicationStartedAt, applicationRunId)
              : original
          if (repaired !== original) {
            // Compare the stored payload to avoid overwriting a concurrent final persist.
            const updated = await database
              .update(sessionMessagesTable)
              .set({ content: JSON.stringify(repaired) })
              .where(and(eq(sessionMessagesTable.id, row.id), eq(sessionMessagesTable.content, row.content)))
            if (updated.rowsAffected === 0) {
              return this.getSessionHistory(sessionId)
            }
          }
          messages.push(repaired)
        }
      }

      logger.info(`Loaded ${messages.length} messages for session ${sessionId}`)
      return messages
    } catch (error) {
      logger.error('Failed to load session history', error as Error)
      throw error
    }
  }
}

export const agentMessageRepository = AgentMessageRepository.getInstance()
