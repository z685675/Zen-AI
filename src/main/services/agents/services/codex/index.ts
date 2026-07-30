import { EventEmitter } from 'node:events'

import { loggerService } from '@logger'
import { config as apiConfigService } from '@main/apiServer/config'
import { cleanupAssistantMcpContext, registerAssistantMcpContext } from '@main/apiServer/routes/assistant-mcp'
import { validateModelId } from '@main/apiServer/utils'
import { getProxyEnvironment } from '@main/services/proxy/nodeProxy'
import { managedPythonService } from '@main/services/python/ManagedPythonService'

import type { GetAgentSessionResponse } from '../..'
import type {
  AgentServiceInterface,
  AgentStream,
  AgentStreamEvent,
  AgentThinkingOptions
} from '../../interfaces/AgentStreamInterface'
import {
  ensureBuiltinAgentRuntimeSkillRoots,
  isProvisioned,
  provisionBuiltinAgent
} from '../builtin/BuiltinAgentProvisioner'
import { getCodexRuntimeDisabledError, isCodexRuntimeEnabled } from '../runtime/features'
import { failAgentStreamBeforeStart } from '../runtime/preflight'
import { buildCodexInvocationConfig, buildCodexMcpServers, prepareCodexInput } from './config'
import { type CodexExecutableResolution, resolveCodexExecutable } from './executable'
import { CodexStreamState, type CodexThreadEvent, transformCodexEventToStreamParts } from './transform'

const logger = loggerService.withContext('CodexService')

type CodexConstructor = new (
  options?: unknown
) => {
  startThread(options?: unknown): CodexThread
  resumeThread(id: string, options?: unknown): CodexThread
}

type CodexThread = {
  id: string | null
  runStreamed(
    input: unknown,
    turnOptions?: { signal?: AbortSignal }
  ): Promise<{
    events: AsyncGenerator<CodexThreadEvent>
  }>
}

export function isMissingCodexRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes('thread/resume') && normalized.includes('no rollout found for thread id')
}

class CodexAgentStream extends EventEmitter implements AgentStream {
  declare emit: (event: 'data', data: AgentStreamEvent) => boolean
  declare on: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
  declare once: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
  sdkSessionId?: string
}

class CodexService implements AgentServiceInterface {
  private codexExecutable?: CodexExecutableResolution

  constructor() {
    this.codexExecutable = resolveCodexExecutable()

    if (this.codexExecutable) {
      logger.info('Resolved Codex executable path', {
        codexExecutablePath: this.codexExecutable.executablePath,
        codexPathDirs: this.codexExecutable.pathDirs
      })
    } else {
      logger.warn('Codex executable path was not resolved; falling back to SDK auto-discovery')
    }
  }

  async invoke(
    prompt: string,
    session: GetAgentSessionResponse,
    abortController: AbortController,
    lastAgentSessionId?: string,
    thinkingOptions?: AgentThinkingOptions,
    images?: Array<{ data: string; media_type: string }>
  ): Promise<AgentStream> {
    const aiStream = new CodexAgentStream()

    if (!isCodexRuntimeEnabled()) {
      return failAgentStreamBeforeStart(aiStream, getCodexRuntimeDisabledError())
    }

    const cwd = session.accessible_paths[0]
    if (!cwd) {
      return failAgentStreamBeforeStart(aiStream, new Error('No accessible paths defined for the agent session'))
    }

    const modelInfo = await validateModelId(session.model)
    if (!modelInfo.valid) {
      return failAgentStreamBeforeStart(
        aiStream,
        new Error(`Invalid model ID '${session.model}': ${JSON.stringify(modelInfo.error)}`)
      )
    }

    if (!modelInfo.provider || !modelInfo.modelId) {
      return failAgentStreamBeforeStart(aiStream, new Error('Provider or model not found for Codex runtime'))
    }

    const builtinRole = (session.configuration as Record<string, unknown> | undefined)?.builtin_role as
      | string
      | undefined

    if (builtinRole) {
      ensureBuiltinAgentRuntimeSkillRoots(cwd)
    }

    if (builtinRole && !isProvisioned(cwd, builtinRole)) {
      const agentConfig = await provisionBuiltinAgent(cwd, builtinRole)
      if (agentConfig?.instructions && !session.instructions) {
        session = { ...session, instructions: agentConfig.instructions }
      }
      logger.info('Provisioned builtin agent workspace for Codex runtime', { builtinRole, cwd })
    }

    let invocationConfig
    let assistantMcpContextId: string | undefined
    try {
      const shouldInjectAssistantMcp = Boolean(builtinRole)
      const apiConfig = session.mcps?.length || shouldInjectAssistantMcp ? await apiConfigService.get() : undefined
      let mcpServers = apiConfig ? buildCodexMcpServers(session.mcps, apiConfig) : undefined

      if (shouldInjectAssistantMcp && apiConfig) {
        registerAssistantMcpContext(session.id, session.accessible_paths)
        assistantMcpContextId = session.id
        mcpServers = {
          ...mcpServers,
          assistant: {
            url: `http://${apiConfig.host}:${apiConfig.port}/v1/assistant/${encodeURIComponent(session.id)}/mcp`,
            bearer_token_env_var: 'ZEN_AGENT_MCP_API_KEY'
          }
        }
      }

      const managedPythonEnv = await managedPythonService.getAgentEnvironment()
      invocationConfig = buildCodexInvocationConfig({
        session,
        provider: modelInfo.provider,
        modelId: modelInfo.modelId,
        cwd,
        codexExecutablePath: this.codexExecutable?.executablePath,
        codexPathDirs: this.codexExecutable?.pathDirs,
        baseEnv: {
          ...process.env,
          ...getProxyEnvironment(process.env),
          ...managedPythonEnv,
          ...(mcpServers && apiConfig ? { ZEN_AGENT_MCP_API_KEY: apiConfig.apiKey } : {})
        },
        mcpServers,
        thinkingOptions
      })
    } catch (error) {
      if (assistantMcpContextId) cleanupAssistantMcpContext(assistantMcpContextId)
      return failAgentStreamBeforeStart(aiStream, error instanceof Error ? error : new Error(String(error)))
    }

    const enhancedPrompt = this.buildPrompt(prompt, session)

    setImmediate(() => {
      this.processCodexStream({
        prompt: enhancedPrompt,
        images,
        invocationConfig,
        stream: aiStream,
        abortController,
        lastAgentSessionId,
        assistantMcpContextId
      }).catch((error) => {
        logger.error('Unhandled Codex stream error', {
          error: error instanceof Error ? { name: error.name, message: error.message } : String(error)
        })
        aiStream.emit('data', {
          type: 'error',
          error: error instanceof Error ? error : new Error(String(error))
        })
      })
    })

    return aiStream
  }

  private buildPrompt(prompt: string, session: GetAgentSessionResponse): string {
    const builtinRole = (session.configuration as Record<string, unknown> | undefined)?.builtin_role as
      | string
      | undefined
    const blocks = [
      session.instructions
        ? [
            '## System Instructions',
            session.instructions,
            'Follow these instructions while completing the user request.'
          ].join('\n')
        : undefined,
      builtinRole
        ? [
            '## Zen AI Managed Capabilities',
            '- Use mcp__assistant__create_file for normal MD/TXT/CSV/DOCX/XLSX/PPTX/PDF creation.',
            '- Use mcp__assistant__python_execute for data analysis, complex transformations, and bundled Python Skill scripts.',
            '- Use mcp__assistant__ocr_file for local image or scanned-PDF OCR.',
            '- The python command resolves to Zen AI managed CPython. Do not probe or install into system Python.',
            '- Keep file access inside the session allowed paths and follow confirmation/backup rules for destructive changes.'
          ].join('\n')
        : undefined,
      prompt
    ].filter((value): value is string => Boolean(value?.trim()))

    return blocks.join('\n\n')
  }

  private async loadCodexConstructor(): Promise<CodexConstructor> {
    const mod = (await import('@openai/codex-sdk')) as { Codex?: CodexConstructor }
    if (!mod.Codex) {
      throw new Error('Codex SDK did not export Codex')
    }
    return mod.Codex
  }

  private async processCodexStream(params: {
    prompt: string
    images?: Array<{ data: string; media_type: string }>
    invocationConfig: ReturnType<typeof buildCodexInvocationConfig>
    stream: CodexAgentStream
    abortController: AbortController
    lastAgentSessionId?: string
    assistantMcpContextId?: string
  }): Promise<void> {
    const state = new CodexStreamState()
    const startTime = Date.now()
    let preparedInput: Awaited<ReturnType<typeof prepareCodexInput>> | undefined

    try {
      const currentInput = await prepareCodexInput(params.prompt, params.images)
      preparedInput = currentInput
      const Codex = await this.loadCodexConstructor()
      const codex = new Codex(params.invocationConfig.clientOptions)
      let observedEvent = false

      const consumeThread = async (thread: CodexThread) => {
        const { events } = await thread.runStreamed(currentInput.input, { signal: params.abortController.signal })

        for await (const event of events) {
          observedEvent = true
          if (event.type === 'thread.started') {
            params.stream.sdkSessionId = event.thread_id
          } else if (thread.id && !params.stream.sdkSessionId) {
            params.stream.sdkSessionId = thread.id
          }

          if (
            (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') &&
            event.item.type === 'error'
          ) {
            logger.warn('Codex emitted non-fatal warning item', {
              eventType: event.type,
              message: event.item.message
            })
          }

          const chunks = transformCodexEventToStreamParts(event, state)
          for (const chunk of chunks) {
            params.stream.emit('data', {
              type: 'chunk',
              chunk
            })

            if (chunk.type === 'error') {
              logger.warn('Codex emitted error chunk', { event })
            }
          }
        }
      }

      const thread = params.lastAgentSessionId
        ? codex.resumeThread(params.lastAgentSessionId, params.invocationConfig.threadOptions)
        : codex.startThread(params.invocationConfig.threadOptions)

      try {
        await consumeThread(thread)
      } catch (error) {
        if (params.lastAgentSessionId && !observedEvent && isMissingCodexRolloutError(error)) {
          logger.warn('Codex resume state was unavailable; delegating recovery to the session service', {
            staleSessionId: params.lastAgentSessionId
          })
        }
        throw error
      }

      logger.debug('Codex stream completed successfully', {
        duration: Date.now() - startTime,
        sdkSessionId: params.stream.sdkSessionId
      })

      params.stream.emit('data', {
        type: 'complete'
      })
    } catch (error) {
      const errorObj = error as any
      const isAborted =
        errorObj?.name === 'AbortError' ||
        errorObj?.message?.includes('aborted') ||
        params.abortController.signal.aborted

      if (isAborted) {
        logger.info('Codex query aborted by client disconnect', { duration: Date.now() - startTime })
        params.stream.emit('data', {
          type: 'cancelled',
          error: new Error('Request aborted by client')
        })
        return
      }

      logger.error('Codex query failed', {
        duration: Date.now() - startTime,
        error: errorObj instanceof Error ? { name: errorObj.name, message: errorObj.message } : String(errorObj)
      })

      params.stream.emit('data', {
        type: 'error',
        error: errorObj instanceof Error ? errorObj : new Error(String(errorObj))
      })
    } finally {
      await preparedInput?.cleanup()
      if (params.assistantMcpContextId) cleanupAssistantMcpContext(params.assistantMcpContextId)
    }
  }
}

export default CodexService
