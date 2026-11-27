import { EventEmitter } from 'node:events'

import { loggerService } from '@logger'
import { touchAssistantMcpContext } from '@main/apiServer/routes/assistant-mcp'
import { touchBrowserMcpContext } from '@main/apiServer/routes/browser-mcp'
import { validateModelId } from '@main/apiServer/utils'
import { recordMainDiagnostic } from '@main/services/DiagnosticEvidenceService'
import type { GetAgentSessionResponse } from '@types'
import type { TextStreamPart } from 'ai'

import { assertDshPreviewUnlocked } from '../../../dshPreview/access'
import {
  type DshEvent,
  type DshRuntime,
  getDshPreviewRuntimeStatus,
  getDshRuntime,
  stopDshSession
} from '../../../dshPreview/runtime'
import type { AgentServiceInterface, AgentStream, AgentThinkingOptions } from '../../interfaces/AgentStreamInterface'
import { failAgentStreamBeforeStart } from '../claudecode/preflight'
import { promptForToolApproval } from '../claudecode/tool-permissions'
import { createTaskDeadline } from '../opencode/taskDeadline'
import { prepareDshConfig } from './config'
import { DshStreamState } from './transform'
import { DshTurnInput } from './turnInput'

const logger = loggerService.withContext('DshService')

// Importing/constructing this service never starts a process or downloads files.
export default class DshService implements AgentServiceInterface {
  async invoke(
    prompt: string,
    session: GetAgentSessionResponse,
    abortController: AbortController,
    _lastAgentSessionId?: string,
    thinkingOptions?: AgentThinkingOptions,
    images?: Array<{ data: string; media_type: string }>
  ): Promise<AgentStream> {
    const stream = new EventEmitter() as AgentStream
    try {
      assertDshPreviewUnlocked()
      if (getDshPreviewRuntimeStatus().state !== 'ready')
        throw new Error('Prepare the DeepSeek Harness preview in Settings before sending a message.')
      const model = await validateModelId(session.model)
      if (!model.valid || !model.provider || !model.modelId)
        throw new Error('Selected model is unavailable; configure a valid Provider/model')
      stream.settled = new Promise<void>((ready) => setImmediate(ready))
        .then(() =>
          this.run(stream, prompt, session, model.provider!, model.modelId!, abortController, thinkingOptions, images)
        )
        .catch((error) => {
          stream.emit('data', { type: 'error', error })
        })
      return stream
    } catch (error) {
      return failAgentStreamBeforeStart(
        stream,
        error instanceof Error ? error : new Error('DeepSeek Harness preview is unavailable')
      )
    }
  }

  private async run(
    stream: AgentStream,
    prompt: string,
    session: GetAgentSessionResponse,
    provider: NonNullable<Awaited<ReturnType<typeof validateModelId>>['provider']>,
    modelId: string,
    abortController: AbortController,
    options?: AgentThinkingOptions,
    images?: Array<{ data: string; media_type: string }>
  ) {
    const signal = abortController.signal
    let runtime: DshRuntime | undefined
    let prepared: Awaited<ReturnType<typeof prepareDshConfig>> | undefined
    let state: DshStreamState | undefined
    let inputs: DshTurnInput | undefined
    let terminalEvent: { type: 'complete' | 'cancelled' } | { type: 'error'; error: Error } | undefined
    let closing = false
    let onEvent: ((event: DshEvent) => void) | undefined
    const approvals = new Map<string | number, AbortController>()
    const emit = (chunk: TextStreamPart<Record<string, any>>) => stream.emit('data', { type: 'chunk', chunk })
    const stage = (status: string) => {
      emit({ type: 'raw', rawValue: { type: 'dsh_status', runtime_id: 'dsh', status } })
      recordMainDiagnostic(options?.diagnosticId, 'runtime', 'task-stage', { runtime: 'dsh', stage: status })
    }
    const deadline = createTaskDeadline((kind) =>
      abortController.abort(
        Object.assign(
          new Error(
            kind === 'human-wait'
              ? 'Waiting for user action exceeded the 30 minute safety limit.'
              : 'DeepSeek Harness made no meaningful progress for 15 minutes.'
          ),
          { code: `dsh_${kind}_timeout` }
        )
      )
    )
    const cancel = () => {
      for (const controller of approvals.values()) controller.abort()
      const owned = runtime
      void owned?.call('session/cancel').catch(() => stopDshSession(session.id, owned))
    }
    signal.addEventListener('abort', cancel, { once: true })
    const heartbeat = setInterval(() => {
      touchAssistantMcpContext(session.id)
      touchBrowserMcpContext(session.id)
    }, 60000)
    try {
      signal.throwIfAborted()
      assertDshPreviewUnlocked()
      stage('connecting')
      prepared = await prepareDshConfig(
        session,
        provider,
        modelId,
        signal,
        () => runtime?.call('session/skills'),
        options?.effort,
        options?.diagnosticId
      )
      signal.throwIfAborted()
      runtime = await getDshRuntime(prepared.config, signal)
      signal.throwIfAborted()
      stream.sdkSessionId = runtime.nativeId
      state = new DshStreamState(session.id, runtime.nativeId)
      inputs = new DshTurnInput(session.id, runtime, signal)
      emit({ type: 'start' })
      emit({ type: 'raw', rawValue: { type: 'init', session_id: runtime.nativeId, runtime_id: 'dsh' } })
      onEvent = (event) => {
        if (event.method === 'host.cancelled') {
          approvals.get(event.params.id)?.abort()
          return
        }
        if (
          event.method === 'session.event' &&
          event.params.event.type === 'tool/call' &&
          event.params.event.data.name?.startsWith('mcp__browser__')
        )
          deadline.wait(`browser-${event.params.sessionId}:${event.params.event.data.callId}`)
        if (event.method === 'session.event' && event.params.event.type === 'tool/result')
          deadline.continue(`browser-${event.params.sessionId}:${event.params.event.data.message.toolCallId}`)
        if (event.method === 'approval/request' && event.id !== undefined) {
          const requestId = event.id
          const controller = new AbortController()
          approvals.set(requestId, controller)
          const permissionSignal = AbortSignal.any([signal, controller.signal])
          deadline.wait(String(requestId))
          stage('waiting_permission')
          void promptForToolApproval(
            event.params.toolName,
            {
              ...(event.params.toolInput || state!.toolInput(event.params.callId)),
              ...(event.params.sessionId !== runtime!.nativeId ? { nativeChildSessionId: event.params.sessionId } : {}),
              ...(event.params.reason ? { nativeReason: event.params.reason } : {})
            },
            {
              signal: permissionSignal,
              toolCallId: `${session.id}:${event.params.sessionId === runtime!.nativeId ? '' : `${event.params.sessionId}:`}${event.params.callId || requestId}`
            }
          )
            .then(
              (result) =>
                runtime?.answer(requestId, {
                  outcome: permissionSignal.aborted
                    ? 'cancelled'
                    : result.behavior === 'allow'
                      ? 'allowed-once'
                      : 'rejected'
                }),
              () => runtime?.answer(requestId, { outcome: 'rejected' })
            )
            .finally(() => {
              approvals.delete(requestId)
              deadline.continue(String(requestId))
              if (!signal.aborted && !closing) stage('busy')
            })
          return
        }
        if (event.params.sessionId !== runtime!.nativeId) {
          // Subagents share this owned process. Their approvals must still reach
          // the host, and native child activity keeps the task deadline alive.
          if (event.method === 'assistant.stream' || event.method === 'session.event') deadline.progress()
          return
        }
        inputs?.observe(event)
        for (const chunk of state!.consume(event)) {
          // A steer message is another native user event, not the outer prompt.
          if (chunk.type === 'raw' && (chunk.rawValue as any)?.type === 'dsh_turn') continue
          deadline.progress()
          emit(chunk)
        }
      }
      runtime.on('event', onEvent)
      stage('busy')
      const admitted = await runtime.call('session/prompt', { text: prompt, images })
      emit({
        type: 'raw',
        rawValue: { type: 'dsh_turn', user_message_id: admitted.messageId, session_id: runtime.nativeId }
      })
      recordMainDiagnostic(options?.diagnosticId, 'runtime', 'prompt-admitted', {
        runtime: 'dsh',
        nativeMessageId: admitted.messageId
      })
      inputs.ready(true)
      await runtime.wait()
      inputs.ready(false)
      signal.throwIfAborted()
      if (state.error) throw state.error
      if (state.terminal === 'aborted' || state.terminal === 'interrupted')
        throw new Error('DeepSeek Harness turn was interrupted')
      if (!state.terminal) throw new Error('DeepSeek Harness stopped without a durable turn result')
      for (const chunk of state.closeParts()) emit(chunk)
      emit({
        type: 'finish',
        totalUsage: state.usage(),
        finishReason: state.terminal === 'max-tokens' ? 'length' : 'stop',
        rawFinishReason: `dsh.${state.terminal}`
      })
      stage('idle')
      terminalEvent = { type: 'complete' }
    } catch (error) {
      for (const chunk of state?.closeParts() || []) emit(chunk)
      if (signal.aborted) terminalEvent = { type: 'cancelled' }
      else {
        const failure = error instanceof Error ? error : new Error('DeepSeek Harness failed')
        logger.warn('DSH turn failed', { sessionId: session.id, kind: failure.name })
        recordMainDiagnostic(options?.diagnosticId, 'runtime', 'failed', {
          runtime: 'dsh',
          error: { name: failure.name, message: failure.message }
        })
        terminalEvent = { type: 'error', error: failure }
      }
    } finally {
      closing = true
      clearInterval(heartbeat)
      signal.removeEventListener('abort', cancel)
      for (const controller of approvals.values()) controller.abort()
      deadline.dispose()
      inputs?.ready(false)
      // A cancelled run still drains/checkpoints the SAME native Agent. Starting
      // another task is always a later explicit user admission.
      if (signal.aborted) await runtime?.call('session/cancel').catch(() => undefined)
      if (runtime) await stopDshSession(session.id, runtime)
      await inputs?.close()
      if (runtime && onEvent) runtime.off('event', onEvent)
      await prepared?.finishTurn().catch(() => undefined)
      prepared?.dispose()
      // Terminal events release the outer session lease. No old cleanup may
      // remain capable of stopping a newly admitted turn after this point.
      if (terminalEvent) stream.emit('data', terminalEvent)
    }
  }
}
