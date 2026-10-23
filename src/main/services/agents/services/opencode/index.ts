import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'

import { loggerService } from '@logger'
import { touchAssistantMcpContext } from '@main/apiServer/routes/assistant-mcp'
import { touchBrowserMcpContext } from '@main/apiServer/routes/browser-mcp'
import { validateModelId } from '@main/apiServer/utils'
import { recordMainDiagnostic } from '@main/services/DiagnosticEvidenceService'
import type { OpenCodeUsageObservation } from '@shared/agents/opencodeDiagnostics'
import { diagnosticText, sanitizeDiagnostic } from '@shared/diagnostics'
import type { GetAgentSessionResponse } from '@types'
import type { TextStreamPart } from 'ai'

import type { AgentServiceInterface, AgentStream, AgentThinkingOptions } from '../../interfaces/AgentStreamInterface'
import { automationInstructions, getAutomationProfile } from '../automation/profile'
import { failAgentStreamBeforeStart } from '../claudecode/preflight'
import { promptForToolApproval } from '../claudecode/tool-permissions'
import type { OpenCodeEvent } from './client'
import { type CompactionEntry, discardEmptyNativeCompaction } from './compactionGuard'
import { OPENCODE_PROVIDER_ID, OPENCODE_VERSION } from './config'
import { OPENCODE_SYSTEM_INSTRUCTIONS } from './instructions'
import { OpenCodePerformance } from './performance'
import { watchOpenCodePermissions } from './permissions'
import { prepareOpenCodeRuntime } from './prepare'
import { type OpenCodeProcess } from './process'
import { createTaskDeadline } from './taskDeadline'
import { type NativeMessage, OpenCodeStreamState } from './transform'
import { OpenCodeUsageTotals } from './usageObservation'

const logger = loggerService.withContext('OpenCodeService')
type Chunk = TextStreamPart<Record<string, any>>

export default class OpenCodeService implements AgentServiceInterface {
  async invoke(
    prompt: string,
    session: GetAgentSessionResponse,
    abortController: AbortController,
    _lastAgentSessionId?: string,
    thinkingOptions?: AgentThinkingOptions,
    images?: Array<{ data: string; media_type: string }>
  ): Promise<AgentStream> {
    const stream = new EventEmitter() as AgentStream
    if (!session.accessible_paths[0])
      return failAgentStreamBeforeStart(stream, new Error('No accessible workspace for new assistant'))
    const modelInfo = await validateModelId(session.model)
    if (!modelInfo.valid || !modelInfo.provider || !modelInfo.modelId)
      return failAgentStreamBeforeStart(
        stream,
        new Error('Selected model is unavailable; configure a valid Provider/model')
      )
    const provider = modelInfo.provider
    // Preparation starts after listeners are attached; cancellation remains
    // effective while the native process/MCP inventory is being initialized.
    setImmediate(() => {
      void this.run(stream, prompt, session, provider, modelInfo.modelId!, abortController, thinkingOptions, images)
    })
    return stream
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
    const eventController = new AbortController()
    const permissionSignal = AbortSignal.any([signal, eventController.signal])
    let runtime: OpenCodeProcess | undefined
    let nativeId: string | undefined
    let completed = false
    let permissions = 0
    let admissionError: unknown
    let permissionError: unknown
    let transportFailure: Record<string, unknown> | undefined
    let admitted = false
    let observedBusy = false
    const startedAt = performance.now()
    const timing = new OpenCodePerformance()
    const usageTotals = new OpenCodeUsageTotals()
    let firstOutputRecorded = false
    let stopPermissionWatcher: (() => void) | undefined
    const unfinishedTools = new Set<string>()
    let currentStatus: string | undefined
    const pendingPermissions = new Set<string>()
    const deadline = createTaskDeadline((kind) =>
      abortController.abort(
        Object.assign(
          new Error(
            kind === 'human-wait'
              ? 'Waiting for user action exceeded the 30 minute safety limit; saved task state was preserved'
              : 'New assistant execution exceeded the 15 minute safety limit; saved task state was preserved'
          ),
          {
            code: kind === 'human-wait' ? 'agent_human_wait_timeout' : 'agent_execution_timeout',
            zenFailureStage: 'local-task-deadline'
          }
        )
      )
    )
    const browserWaits = new Set<string>()
    const emit = (chunk: Chunk) => {
      if (chunk.type === 'tool-call') unfinishedTools.add(chunk.toolCallId)
      else if (chunk.type === 'tool-result' || chunk.type === 'tool-error') unfinishedTools.delete(chunk.toolCallId)
      if (
        chunk.type === 'tool-call' &&
        chunk.toolName.includes('browser') &&
        chunk.toolName.includes('wait_for_user')
      ) {
        browserWaits.add(chunk.toolCallId)
        deadline.wait(`browser:${chunk.toolCallId}`)
      } else if (
        (chunk.type === 'tool-result' || chunk.type === 'tool-error') &&
        browserWaits.delete(chunk.toolCallId)
      ) {
        deadline.continue(`browser:${chunk.toolCallId}`)
      }
      return stream.emit('data', { type: 'chunk', chunk })
    }
    const publishDiagnostics = (outcome: 'completed' | 'failed' | 'cancelled') => {
      const snapshot = usageTotals.snapshot(provider.id, modelId, timing.snapshot(outcome))
      emit({ type: 'raw', rawValue: { type: 'opencode_diagnostics', diagnostics: snapshot } })
      return snapshot
    }
    const status = (value: string) => {
      if (value === currentStatus) return
      currentStatus = value
      timing.changeStage(value)
      recordMainDiagnostic(options?.diagnosticId, 'runtime', 'task-stage', {
        runtime: 'opencode',
        stage: value,
        elapsedMs: Math.round(performance.now() - startedAt)
      })
      emit({ type: 'raw', rawValue: { type: 'opencode_status', status: value, runtime_id: 'opencode' } })
    }
    const cancel = () => {
      eventController.abort(signal.reason)
      runtime?.stop(signal.reason instanceof Error ? 'task-aborted' : 'user-cancelled')
    }
    signal.addEventListener('abort', cancel, { once: true })
    const retryStarted = { at: 0 }
    let retryTimeout: ReturnType<typeof setTimeout> | undefined
    const heartbeat = setInterval(() => {
      touchAssistantMcpContext(session.id)
      touchBrowserMcpContext(session.id)
    }, 60_000)
    try {
      signal.throwIfAborted()
      status('connecting')
      recordMainDiagnostic(options?.diagnosticId, 'runtime', 'transport-config', {
        runtime: 'opencode',
        version: OPENCODE_VERSION,
        apiHost: provider.apiHost,
        providerId: provider.id,
        modelId,
        transport: 'opencode-native-provider'
      })
      runtime = await prepareOpenCodeRuntime(session, signal, {
        provider,
        modelId,
        effort: options?.effort,
        diagnosticId: options?.diagnosticId,
        onStarting: () => status('starting')
      })
      timing.preparationMs = performance.now() - startedAt
      runtime.setDiagnosticOperation(options?.diagnosticId, signal)
      runtime.setProgressListener((event, details) => {
        if (event === 'usage-observed') usageTotals.observe(details as unknown as OpenCodeUsageObservation)
        timing.transport(event, details)
        // Only keep the latest attempt's evidence. A recovered request must not
        // turn a later tool/server failure into a stale local network diagnosis.
        if (event === 'request-started' || event === 'headers-received' || event === 'body-complete')
          transportFailure = undefined
        else if (event === 'failed') transportFailure = sanitizeDiagnostic(details) as Record<string, unknown>
        if (event === 'request-started' && currentStatus !== 'compacting' && currentStatus !== 'waiting_permission')
          status('waiting_model')
      })
      status('restoring')
      nativeId = await runtime.session(signal)
      stream.sdkSessionId = nativeId
      emit({ type: 'start' })
      emit({ type: 'raw', rawValue: { type: 'init', session_id: nativeId, runtime_id: 'opencode' } })
      const verifyCompaction = async (history: CompactionEntry[], phase: string, running = false) => {
        if (!(await discardEmptyNativeCompaction(runtime!.client, nativeId!, history, signal, running))) return
        recordMainDiagnostic(options?.diagnosticId, 'runtime', 'empty-native-summary-discarded', {
          runtime: 'opencode',
          phase
        })
        if (running)
          throw Object.assign(
            new Error('OpenCode returned an empty context summary. Original conversation was preserved; please retry.'),
            {
              name: 'OpenCodeEmptyCompactionError',
              zenFailureStage: 'agent-runtime',
              zenRuntimeId: 'opencode'
            }
          )
      }
      const existing = await runtime.client.request<Array<CompactionEntry & { info: NativeMessage }>>(
        `/session/${nativeId}/message`,
        'GET',
        undefined,
        signal
      )
      await verifyCompaction(existing, 'before-submission')
      const state = new OpenCodeStreamState(nativeId, session.id, new Set(existing.map((item) => item.info.id)))
      let iterator = runtime.client.events(AbortSignal.any([signal, eventController.signal]))
      // Do not submit a task until the event channel is ready.
      const first = await iterator.next()
      if (first.done || first.value.type !== 'server.connected')
        throw new Error('OpenCode event stream handshake failed')
      const messageId = `msg_${(BigInt(Date.now()) * 4096n).toString(16).padStart(12, '0')}${randomBytes(7).toString('hex')}`
      emit({ type: 'raw', rawValue: { type: 'opencode_turn', user_message_id: messageId, session_id: nativeId } })
      const body = {
        messageID: messageId,
        agent: session.configuration?.permission_mode === 'plan' ? 'plan' : 'build',
        model: { providerID: OPENCODE_PROVIDER_ID, modelID: modelId },
        system: getAutomationProfile(session)
          ? automationInstructions(getAutomationProfile(session)!)
          : [OPENCODE_SYSTEM_INSTRUCTIONS, session.instructions || ''].join('\n\n'),
        parts: [
          { type: 'text', text: prompt },
          ...(images || []).map((img) => ({
            type: 'file',
            mime: img.media_type,
            url: `data:${img.media_type};base64,${img.data}`
          }))
        ]
      }
      // Exactly one submission. A transport timeout is ambiguous, so reconcile
      // durable messages rather than resubmitting and duplicating side effects.
      status('submitting')
      const submission = runtime.client
        .request(`/session/${nativeId}/prompt_async`, 'POST', body, signal)
        .catch((error) => {
          admissionError = error
          eventController.abort('submission status uncertain')
        })
      const reconcile = async () => {
        const messages = await runtime!.client.request<Array<CompactionEntry & { info: NativeMessage }>>(
          `/session/${nativeId}/message`,
          'GET',
          undefined,
          signal
        )
        await verifyCompaction(messages, 'reconciliation', true)
        if (messages.some((item) => item.info.id === messageId)) admitted = true
        for (const message of messages) {
          for (const chunk of state.consume({ type: 'message.updated', properties: { info: message.info } }))
            emit(chunk)
          for (const part of message.parts) {
            const chunks = state.consume({ type: 'message.part.updated', properties: { part } })
            timing.chunks(chunks)
            for (const chunk of chunks) emit(chunk)
          }
        }
        const failure = [...state.messages.values()].find((info) => info.error)
        if (failure) throw this.nativeError(failure.error)
        const latest = [...state.messages.values()].at(-1)
        return admitted && Boolean(latest?.time?.completed) && state.hasVisibleOutput
      }
      const permission = async (props: OpenCodeEvent['properties']) => {
        if (permissionSignal.aborted || completed || pendingPermissions.has(props.id)) return
        pendingPermissions.add(props.id)
        if (getAutomationProfile(session)) {
          await runtime!.client.request(
            `/permission/${encodeURIComponent(props.id)}/reply`,
            'POST',
            { reply: 'reject', message: 'Background entry requires desktop authorization' },
            signal
          )
          throw Object.assign(new Error('Background task requires desktop authorization'), {
            code: 'automation_needs_desktop'
          })
        }
        permissions++
        deadline.wait(`permission:${props.id}`)
        status('waiting_permission')
        try {
          const result = await promptForToolApproval(props.permission, props.metadata || { patterns: props.patterns }, {
            signal: permissionSignal,
            toolCallId: `${session.id}:${props.tool?.callID || props.id}`
          })
          await runtime!.client.request(
            `/permission/${encodeURIComponent(props.id)}/reply`,
            'POST',
            {
              reply: result.behavior === 'allow' ? 'once' : 'reject',
              ...(result.behavior === 'deny' ? { message: result.message } : {})
            },
            permissionSignal
          )
        } finally {
          permissions--
          deadline.continue(`permission:${props.id}`)
          if (!permissionSignal.aborted) status(permissions > 0 ? 'waiting_permission' : 'busy')
        }
      }
      const requestPermission = (props: OpenCodeEvent['properties']) => {
        void permission(props).catch((error) => {
          if (permissionSignal.aborted) return
          permissionError = error
          eventController.abort('permission reply failed')
        })
      }
      const handle = async (event: OpenCodeEvent) => {
        const props = event.properties
        const eventSession = props.sessionID || props.info?.sessionID || props.part?.sessionID
        if (eventSession && eventSession !== nativeId) return
        if (event.type === 'message.updated' && props.info?.id === messageId) admitted = true
        if (event.type === 'message.updated' && props.info?.summary && !state.previousMessages.has(props.info.id))
          status('compacting')
        if (event.type === 'session.error') throw this.nativeError(props.error)
        if (event.type === 'server.instance.disposed')
          throw new Error('OpenCode local instance was disposed during the task')
        if (event.type === 'permission.asked') requestPermission(props)
        if (event.type === 'session.compacted') {
          const history = await runtime!.client.request<CompactionEntry[]>(
            `/session/${nativeId}/message`,
            'GET',
            undefined,
            signal
          )
          await verifyCompaction(history, 'during-task', true)
          status('busy')
          recordMainDiagnostic(options?.diagnosticId, 'runtime', 'native-compacted', { runtime: 'opencode' })
        }
        if (event.type === 'session.status') {
          const next = props.status
          if (next?.type === 'busy') {
            observedBusy = true
            status(permissions > 0 ? 'waiting_permission' : 'busy')
          }
          if (next?.type === 'retry') {
            timing.retry()
            if (!retryTimeout)
              retryTimeout = setTimeout(
                () =>
                  abortController.abort(new Error('Upstream retry budget exhausted; native task state was preserved')),
                120_000
              )
            retryStarted.at ||= Date.now()
            if (next.attempt > 3 || Date.now() - retryStarted.at > 120_000)
              throw new Error('Upstream retry budget exhausted; native task state was preserved')
            status('retrying')
            recordMainDiagnostic(options?.diagnosticId, 'runtime', 'native-retry', { attempt: next.attempt })
          }
          if (next?.type === 'idle' && admitted && observedBusy && !permissions) {
            completed = await reconcile()
            if (!completed) throw new Error('The new assistant returned an empty or incomplete result')
          }
        }
        const chunks = state.consume(event)
        timing.chunks(chunks)
        if (
          !firstOutputRecorded &&
          chunks.some((chunk) => ['tool-call', 'text-delta', 'reasoning-delta'].includes(chunk.type))
        ) {
          firstOutputRecorded = true
          recordMainDiagnostic(options?.diagnosticId, 'runtime', 'first-task-output', {
            runtime: 'opencode',
            elapsedMs: Math.round(performance.now() - startedAt)
          })
        }
        if (
          chunks.some(
            (chunk) => chunk.type === 'tool-call' || chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'
          )
        ) {
          transportFailure = undefined
          clearTimeout(retryTimeout)
          retryTimeout = undefined
          retryStarted.at = 0
        }
        for (const chunk of chunks) emit(chunk)
      }
      stopPermissionWatcher = watchOpenCodePermissions({
        client: runtime.client,
        sessionId: nativeId,
        signal: permissionSignal,
        hasUnfinishedTools: () => unfinishedTools.size > 0 && permissions === 0,
        onPermission: (pending) => {
          if (!pendingPermissions.has(pending.id))
            recordMainDiagnostic(options?.diagnosticId, 'runtime', 'permission-event-recovered', {
              runtime: 'opencode',
              permission: pending.permission
            })
          requestPermission(pending)
        },
        onError: (error) => {
          // A transient local inspection failure does not replay or stop the
          // task. Keep it visible in diagnostics; the task deadline is bounded.
          recordMainDiagnostic(options?.diagnosticId, 'runtime', 'permission-sync-failed', {
            runtime: 'opencode',
            error
          })
        }
      })
      let eventReconnects = 0
      while (!completed) {
        let semanticFailure = false
        try {
          for await (const event of iterator) {
            try {
              await handle(event)
            } catch (error) {
              semanticFailure = true
              throw error
            }
            if (completed) break
          }
          if (!completed) throw new Error('OpenCode event stream ended before task completion')
        } catch (error) {
          if (permissionError) throw permissionError
          if (signal.aborted || semanticFailure || eventController.signal.aborted) throw admissionError || error
          // A broken local event connection is not a failed upstream task.
          // Reattach to that SAME task; never submit prompt_async a second time.
          const nativeStatus = await runtime.client.request<Record<string, { type: string }>>(
            '/session/status',
            'GET',
            undefined,
            signal
          )
          if (nativeStatus[nativeId]?.type === 'idle' || !nativeStatus[nativeId]) {
            completed = await reconcile()
            if (!completed) throw admissionError || error
            break
          }
          if (eventReconnects >= 2) throw error
          eventReconnects++
          iterator = runtime.client.events(AbortSignal.any([signal, eventController.signal]))
          let resumeEvents = false
          try {
            const connected = await iterator.next()
            if (connected.done || connected.value.type !== 'server.connected')
              throw new Error('OpenCode event stream reconnection failed')
            // Subscribe BEFORE reading durable state so updates in the recovery
            // window are queued. State translation deduplicates the overlap.
            await reconcile()
            const waiting = await runtime.client.request<OpenCodeEvent['properties'][]>(
              '/permission',
              'GET',
              undefined,
              signal
            )
            for (const pending of waiting) {
              if (pending.sessionID === nativeId) await handle({ type: 'permission.asked', properties: pending })
            }
            const after = await runtime.client.request<Record<string, { type: string }>>(
              '/session/status',
              'GET',
              undefined,
              signal
            )
            observedBusy = true
            if (!after[nativeId] || after[nativeId].type === 'idle') {
              completed = await reconcile()
              if (!completed) throw new Error('The new assistant returned an empty or incomplete result')
            }
            recordMainDiagnostic(options?.diagnosticId, 'runtime', 'event-stream-reconnected', {
              runtime: 'opencode',
              attempt: eventReconnects
            })
            resumeEvents = !completed
          } finally {
            // A completed reconciliation may leave a newly subscribed generator
            // suspended at its handshake rather than inside a for-await loop.
            if (!resumeEvents) await iterator.return(undefined)
          }
        }
      }
      await submission
      if (!completed || !state.hasVisibleOutput)
        throw admissionError || new Error('The new assistant completed without a visible result')
      for (const chunk of state.closeParts()) emit(chunk)
      runtime?.flushDiagnostic()
      const diagnostics = publishDiagnostics('completed')
      emit({
        type: 'finish',
        totalUsage: state.usage(),
        finishReason: 'stop',
        rawFinishReason: 'opencode.session.idle'
      })
      status('idle')
      recordMainDiagnostic(options?.diagnosticId, 'runtime', 'complete', {
        runtime: 'opencode',
        performance: diagnostics.performance,
        usageDiagnostics: diagnostics
      })
      stream.emit('data', { type: 'complete' })
    } catch (error) {
      runtime?.flushDiagnostic()
      runtime?.stop(signal.aborted ? 'task-aborted' : 'task-failed')
      if (signal.aborted && !(signal.reason instanceof Error)) {
        const diagnostics = publishDiagnostics('cancelled')
        recordMainDiagnostic(options?.diagnosticId, 'runtime', 'complete', {
          runtime: 'opencode',
          performance: diagnostics.performance,
          usageDiagnostics: diagnostics
        })
        stream.emit('data', { type: 'cancelled' })
      } else {
        const diagnostics = publishDiagnostics('failed')
        const failure =
          signal.aborted && signal.reason instanceof Error
            ? signal.reason
            : error instanceof Error
              ? error
              : new Error(String(error))
        if (transportFailure) {
          Object.assign(failure, {
            zenTransportFailure: transportFailure,
            zenRequestUrl: transportFailure.url,
            zenFailureStage: transportFailure.receivedResponse ? 'provider-stream' : 'provider-connect'
          })
        }
        recordMainDiagnostic(options?.diagnosticId, 'runtime', 'failed', {
          runtime: 'opencode',
          error: failure,
          performance: diagnostics.performance,
          usageDiagnostics: diagnostics,
          startup: 'zenFailureStage' in failure && failure.zenFailureStage === 'runtime-startup'
        })
        logger.warn('New assistant task stopped', { name: failure.name })
        stream.emit('data', { type: 'error', error: failure })
      }
    } finally {
      stopPermissionWatcher?.()
      deadline.dispose()
      clearTimeout(retryTimeout)
      clearInterval(heartbeat)
      eventController.abort('turn finished')
      signal.removeEventListener('abort', cancel)
      runtime?.setProgressListener(undefined)
      runtime?.release()
    }
  }

  private nativeError(error: { name?: string; data?: { message?: string; statusCode?: number } } | undefined): Error {
    return Object.assign(new Error(diagnosticText(error?.data?.message || 'OpenCode native task failed')), {
      name: error?.name || 'OpenCodeError',
      status: error?.data?.statusCode,
      zenFailureStage: 'agent-runtime',
      zenRuntimeId: 'opencode'
    })
  }
}
