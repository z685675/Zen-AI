/**
 * BuiltinAgentBootstrap
 *
 * Encapsulates all startup initialization logic for built-in skills and agents
 * (Zen Agent, Cherry Assistant, etc.). Keeps business details out of
 * the main entry point (`src/main/index.ts`).
 */
import { loggerService } from '@logger'
import { installBuiltinSkills } from '@main/utils/builtinSkills'
import {
  DEFAULT_CHERRY_ASSISTANT_AGENT_ID,
  DEFAULT_CHERRY_CLAW_AGENT_ID,
  DEFAULT_FUSION_AGENT_ID
} from '@shared/config/agents'

import { agentService } from '../AgentService'
import { schedulerService } from '../SchedulerService'
import { sessionService } from '../SessionService'
import { provisionBuiltinAgent } from './BuiltinAgentProvisioner'

const logger = loggerService.withContext('BuiltinAgentBootstrap')

/**
 * Initialize all built-in skills and agents. Safe to call multiple times (idempotent).
 *
 * Skills are installed first (shared dependency). Agent inits run in parallel
 * since they operate on different rows and don't conflict.
 */
export async function bootstrapBuiltinAgents(): Promise<void> {
  try {
    await installBuiltinSkills()
  } catch (error) {
    logger.error('Failed to install built-in skills', error as Error)
  }
  await initFusionAgent()
  await cleanupLegacyBuiltinEmptySessions()
  await markLegacyAgentsDeprecated()
}

async function syncBuiltinSessionDefaults(agentId: string): Promise<void> {
  const agent = await agentService.getAgent(agentId)
  if (!agent) {
    return
  }

  if (agent.instructions) {
    await sessionService.syncAgentSessionInstructions(agentId, agent.instructions)
  }
  if (agent.configuration) {
    await sessionService.syncAgentSessionConfiguration(agentId, agent.configuration)
  }
}

async function markLegacyAgentsDeprecated(): Promise<void> {
  try {
    await agentService.markLegacyUserAgentsDeprecated()
  } catch (error) {
    logger.warn('Failed to mark legacy user agents as deprecated:', error as Error)
  }
}

async function cleanupLegacyBuiltinEmptySessions(): Promise<void> {
  try {
    await sessionService.deleteEmptySessionsForAgents([DEFAULT_CHERRY_CLAW_AGENT_ID, DEFAULT_CHERRY_ASSISTANT_AGENT_ID])
  } catch (error) {
    logger.warn('Failed to cleanup legacy built-in empty sessions:', error as Error)
  }
}

// ── CherryClaw ──────────────────────────────────────────────────────

// ── Cherry Assistant ────────────────────────────────────────────────

async function initFusionAgent(): Promise<void> {
  try {
    const agentId = await agentService.initBuiltinAgent({
      id: DEFAULT_FUSION_AGENT_ID,
      builtinRole: 'fusion',
      provisionWorkspace: provisionBuiltinAgent
    })
    if (!agentId) return

    const { total } = await sessionService.listSessions(agentId, { limit: 1 })
    if (total === 0) {
      await sessionService.createSession(agentId, {})
      logger.info('Default session created for fusion agent')
    }

    await syncBuiltinSessionDefaults(agentId)
    await schedulerService.ensureHeartbeatTask(agentId, 30)
  } catch (error) {
    logger.warn('Failed to init fusion agent:', error as Error)
  }
}
