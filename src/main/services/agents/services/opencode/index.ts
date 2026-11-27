import { EventEmitter } from 'node:events'

import { loggerService } from '@logger'
import { touchAssistantMcpContext } from '@main/apiServer/routes/assistant-mcp'
import { touchBrowserMcpContext } from '@main/apiServer/routes/browser-mcp'
import { validateModelId } from '@main/apiServer/utils'
import { recordMainDiagnostic } from '@main/services/DiagnosticEvidenceService'
import type { OpenCodeUsageObservation } from '@shared/agents/opencodeDiagnostics'
import { getOpenCodeAgentMode } from '@shared/agents/opencodeMode'
import { isOpenCodeInternalProgress } from '@shared/agents/opencodeProgress'
import { AGENT_HUMAN_WAIT_TIMEOUT_MS, AGENT_INACTIVITY_TIMEOUT_MS } from '@shared/agents/taskDeadline'
import { diagnosticText, sanitizeDiagnostic } from '@shared/diagnostics'
import { shouldShowModelDailyQuotaNotice } from '@shared/utils/modelDailyQuotaTurn'
import type { GetAgentSessionResponse } from '@types'
import type { TextStreamPart } from 'ai'

import type { AgentServiceInterface, AgentStream, AgentThinkingOptions } from '../../interfaces/AgentStreamInterface'
import { automationInstructions, getAutomationProfile } from '../automation/profile'
import { failAgentStreamBeforeStart } from '../claudecode/preflight'
import { promptForToolApproval } from '../claudecode/tool-permissions'
import type { OpenCodeEvent } from './client'
import { type CompactionEntry, discardEmptyNativeCompaction } from './compactionGuard'
import { OPENCODE_PROVIDER_ID, OPENCODE_VERSION } from './config'
import { resolveOpenCodeContext } from './context'
import { prepareOpenCodeInput } from './inputMaterial'
import { getOpenCodeSharedInstructions } from './instructions'
import { isInvalidReadToolLoop, isNativePermissionRejection, OpenCodeLoopRecovery } from './loopRecovery'
import { OpenCodePerformance } from './performance'
import { watchOpenCodePermissions } from './permissions'
import { prepareOpenCodeRuntime } from './prepare'
import { type OpenCodeProcess } from './process'
import { answerOpenCodeQuestion, type OpenCodeQuestion } from './questions'
import { OpenCodeSubagents } from './subagents'
import { createTaskDeadline } from './taskDeadline'
import { type NativeMessage, OpenCodeStreamState } from './transform'
import { newOpenCodeMessageId, OpenCodeTurnInput } from './turnInput'
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
    stream.settled = new Promise<void>((ready) => setImmediate(ready))
      .then(() =>
        this.run(stream, prompt, session, provider, modelInfo.modelId!, abortController, thinkingOptions, images)
      )
      .catch((error) => {
        stream.emit('data', { type: 'error', error })
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
    let turnInput: OpenCodeTurnInput | undefined
    let subagents: OpenCodeSubagents | undefined
    let nativeId: string | undefined
    let completed = false
    let permissions = 0
    let activeQuestions = 0
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
    let compacting = false
    let pendingOverflow: NativeMessage['error']
    let overflowMessages = new Set<string>()
    let consecutiveOverflows = 0
    let lastContextProgressLog: number | undefined
    let contextProgressCharacters = 0
    const completedCompactions = new Set<string>()
    const pendingPermissions = new Set<string>()
    const pendingQuestions = new Set<string>()
    const approvalControllers = new Map<string, AbortController>()
    const permissionTasks = new Set<Promise<void>>()
    const loopRecovery = new OpenCodeLoopRecovery()
    const deadline = createTaskDeadline((kind) =>
      abortController.abort(
        Object.assign(
          new Error(
            kind === 'human-wait'
              ? 'Waiting for user action exceeded the 30 minute safety limit; saved task state was preserved'
              : 'New assistant made no meaningful progress for 15 minutes; saved task state was preserved'
          ),
          {
            code: kind === 'human-wait' ? 'agent_human_wait_timeout' : 'agent_inactivity_timeout',
            zenFailureStage: 'local-task-deadline',
            timeoutMs: kind === 'human-wait' ? AGENT_HUMAN_WAIT_TIMEOUT_MS : AGENT_INACTIVITY_TIMEOUT_MS,
            phase: currentStatus,
            progressEvidence: timing.snapshot('failed').activity
          }
        )
      )
    )
    const browserWaits = new Set<string>()
    const emit = (chunk: Chunk) => {
      if (chunk.type === 'tool-call') runtime?.observeToolArguments?.(chunk.toolCallId, chunk.toolName, chunk.input)
      if (chunk.type === 'tool-call' || chunk.type === 'tool-result' || chunk.type === 'tool-error') {
        const metadata = chunk.providerMetadata?.opencode as
          | { toolStartedAt?: number; toolFinishedAt?: number; toolExitCode?: number | null }
          | undefined
        if (metadata?.toolStartedAt !== undefined)
          recordMainDiagnostic(options?.diagnosticId, 'runtime', 'native-tool-timing', {
            runtime: 'opencode',
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            phase: chunk.type,
            ...(metadata.toolExitCode === undefined ? {} : { exitCode: metadata.toolExitCode }),
            nativeStartedAt: new Date(metadata.toolStartedAt).toISOString(),
            ...(metadata.toolFinishedAt === undefined
              ? {}
              : {
                  nativeFinishedAt: new Date(metadata.toolFinishedAt).toISOString(),
                  nativeDurationMs: Math.max(0, metadata.toolFinishedAt - metadata.toolStartedAt)
                }),
            observationDelayMs: Math.max(0, Date.now() - (metadata.toolFinishedAt ?? metadata.toolStartedAt))
          })
      }
      if (chunk.type === 'raw' && isOpenCodeInternalProgress(chunk.rawValue)) {
        deadline.progress()
        contextProgressCharacters += chunk.rawValue.characters
        const now = performance.now()
        if (
          lastContextProgressLog === undefined ||
          now - lastContextProgressLog >= 10_000 ||
          chunk.rawValue.kind === 'completed'
        ) {
          lastContextProgressLog = now
          recordMainDiagnostic(options?.diagnosticId, 'runtime', 'context-progress', {
            runtime: 'opencode',
            kind: chunk.rawValue.kind,
            characters: contextProgressCharacters,
            elapsedMs: Math.round(now - startedAt)
          })
        }
      }
      if (
        chunk.type === 'tool-call' ||
        chunk.type === 'tool-result' ||
        chunk.type === 'tool-error' ||
        ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.length > 0)
      )
        deadline.progress()
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
      // Native busy updates describe activity, not completion of the summary.
      if (compacting && (value === 'busy' || value === 'waiting_model')) value = 'compacting'
      if (permissions > 0 && ['busy', 'waiting_model', 'compacting', 'waiting_permission'].includes(value))
        value = activeQuestions > 0 ? 'waiting_answer' : 'waiting_permission'
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
    const clearRetryBudget = () => {
      clearTimeout(retryTimeout)
      retryTimeout = undefined
      retryStarted.at = 0
    }
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
        transport: 'opencode-native-provider',
        toolArgumentAuditVersion: 1,
        loopRecoveryVersion: 1
      })
      let { usableInput } = resolveOpenCodeContext(
        provider.models.find((model) => model.id === modelId) ?? { id: modelId }
      )
      runtime = await prepareOpenCodeRuntime(session, signal, {
        provider,
        modelId,
        effort: options?.effort,
        diagnosticId: options?.diagnosticId,
        onStarting: () => status('starting'),
        onInputBudget: (tokens) => {
          usableInput = tokens
        }
      })
      timing.preparationMs = performance.now() - startedAt
      deadline.progress()
      runtime.setDiagnosticOperation(options?.diagnosticId, signal)
      runtime.setProgressListener((event, details) => {
        if (event === 'usage-observed') usageTotals.observe(details as unknown as OpenCodeUsageObservation)
        timing.transport(event, details)
        if (event === 'tool-input-progress' && typeof details.characters === 'number' && details.characters > 0)
          deadline.progress()
        // Only keep the latest attempt's evidence. A recovered request must not
        // turn a later tool/server failure into a stale local network diagnosis.
        if (
          [
            'quota-check-started',
            'quota-check-complete',
            'request-started',
            'headers-received',
            'body-complete'
          ].includes(event)
        )
          transportFailure = undefined
        else if (event === 'failed' || event === 'quota-refused')
          transportFailure = sanitizeDiagnostic(details) as Record<string, unknown>
        if (event === 'request-started' && currentStatus !== 'compacting' && currentStatus !== 'waiting_permission')
          status('waiting_model')
      })
      status('restoring')
      nativeId = await runtime.session(signal)
      subagents = new OpenCodeSubagents(runtime.client, nativeId, session.id, signal, (tasks) =>
        emit({ type: 'raw', rawValue: { type: 'opencode_subagents', tasks } })
      )
      deadline.progress()
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
      const messageId = newOpenCodeMessageId()
      if (!getAutomationProfile(session) && getOpenCodeAgentMode(session.configuration?.permission_mode) !== 'plan')
        runtime.beginFileChanges?.(messageId, session.accessible_paths, signal)
      emit({ type: 'raw', rawValue: { type: 'opencode_turn', user_message_id: messageId, session_id: nativeId } })
      const system = getAutomationProfile(session)
        ? automationInstructions(getAutomationProfile(session)!)
        : getOpenCodeSharedInstructions(session)
      const prepareText = async (text: string) => {
        // Lightweight automation intentionally has no native read tool.
        if (getAutomationProfile(session)) return text
        const prepared = await prepareOpenCodeInput({
          text,
          directory: runtime!.inputDirectory,
          usableInput,
          system,
          signal
        })
        if (prepared.material)
          recordMainDiagnostic(options?.diagnosticId, 'runtime', 'large-input-materialized', {
            runtime: 'opencode',
            bytes: prepared.material.bytes,
            segments: prepared.material.segments
          })
        return prepared.text
      }
      status('submitting')
      const body = {
        messageID: messageId,
        agent: getOpenCodeAgentMode(session.configuration?.permission_mode),
        model: { providerID: OPENCODE_PROVIDER_ID, modelID: modelId },
        system,
        parts: [
          { type: 'text', text: await prepareText(prompt) },
          ...(images || []).map((img) => ({
            type: 'file',
            mime: img.media_type,
            url: `data:${img.media_type};base64,${img.data}`
          }))
        ]
      }
      // Submit the original task exactly once. A user-directed continuation
      // after a rejected loop gets a separate synthetic message in this history.
      // Ambiguous transport errors never replay either submission.
      status('submitting')
      const submission = runtime.client
        .request(`/session/${nativeId}/prompt_async`, 'POST', body, signal)
        .catch((error) => {
          admissionError = error
          eventController.abort('submission status uncertain')
        })
      turnInput = new OpenCodeTurnInput(
        session.id,
        messageId,
        runtime.client,
        nativeId,
        body,
        signal,
        (receipt) => {
          recordMainDiagnostic(options?.diagnosticId, 'runtime', 'user-input-received', {
            runtime: 'opencode',
            inputId: receipt.id,
            state: receipt.state,
            nativeMessageId: receipt.nativeMessageId
          })
        },
        prepareText
      )
      let awaitingNativeRun = false
      let idlePending = false
      let wakeIdle: (() => void) | undefined
      const trackPermission = (task: Promise<void>) => {
        permissionTasks.add(task)
        void task.finally(() => {
          permissionTasks.delete(task)
          if (idlePending && !permissionTasks.size) wakeIdle?.()
        })
      }
      const reconcile = async (atIdle = false) => {
        awaitingNativeRun = false
        await turnInput?.settle()
        let messages = await runtime!.client.request<Array<CompactionEntry & { info: NativeMessage }>>(
          `/session/${nativeId}/message`,
          'GET',
          undefined,
          signal
        )
        if (atIdle && loopRecovery.waiting) {
          turnInput?.ready(false)
          if (permissionError) throw permissionError
          const recovery = await loopRecovery.resume({
            client: runtime!.client,
            sessionId: nativeId!,
            previousMessages: state.previousMessages,
            body,
            signal,
            onSubmitted: (id) => turnInput?.continued(id)
          })
          if (recovery) {
            messages = recovery.history as typeof messages
            transportFailure = undefined
            status('busy')
            recordMainDiagnostic(options?.diagnosticId, 'runtime', 'doom-loop-continued', {
              runtime: 'opencode',
              requestId: recovery.requestId,
              nativeMessageId: recovery.messageId,
              attempt: recovery.attempt,
              reason: recovery.reason,
              finalizing: recovery.finalizing,
              evidenceCharacters: recovery.evidenceCharacters
            })
          }
        }
        await verifyCompaction(messages, 'reconciliation', true)
        turnInput?.reconcile(messages)
        if (messages.some((item) => item.info.id === messageId)) admitted = true
        for (const message of messages) {
          for (const chunk of state.consume({ type: 'message.updated', properties: { info: message.info } }))
            emit(chunk)
          for (const part of message.parts) {
            if (!state.previousMessages.has(message.info.id)) await subagents?.observeParent(part)
            const chunks = state.consume({ type: 'message.part.updated', properties: { part } })
            timing.chunks(chunks)
            for (const chunk of chunks) emit(chunk)
          }
        }
        const failure = [...state.messages.values()].find(
          (info) => info.error && !loopRecovery.recoveredMessage(info.id) && !loopRecovery.expects(info.error)
        )
        if (failure) throw this.nativeError(failure.error)
        // Durable history is ordered. Reconnection can insert an older summary
        // into the stream-state map after a newer answer was already observed.
        const latest = messages.findLast(
          (entry) => entry.info.role === 'assistant' && !state.previousMessages.has(entry.info.id)
        )?.info
        if (atIdle && pendingOverflow) {
          const answer = messages.find((entry) => entry.info.id === latest?.id)
          if (
            !latest?.time?.completed ||
            latest.summary ||
            overflowMessages.has(latest.id) ||
            !answer?.parts.some((part) => part.type === 'text' && part.text?.trim())
          )
            throw this.nativeError(pendingOverflow)
          pendingOverflow = undefined
        }
        if (loopRecovery.waiting) {
          awaitingNativeRun = true
          return false
        }
        const backgroundResult = subagents?.latestBackgroundResult
        if (subagents?.unfinished || (backgroundResult && (!latest?.parentID || latest.parentID < backgroundResult))) {
          awaitingNativeRun = true
          return false
        }
        if (loopRecovery.latestMessageId && (!latest?.parentID || latest.parentID < loopRecovery.latestMessageId)) {
          // The old processor and abort barrier both emit idle. Neither is the
          // completion of the newly admitted continuation; wait for its output.
          awaitingNativeRun = true
          return false
        }
        if (atIdle && (loopRecovery.latestMessageId || backgroundResult)) {
          const answer = messages.find((entry) => entry.info.id === latest?.id)
          if (
            !latest?.time?.completed ||
            latest.summary ||
            !answer?.parts.some((part) => part.type === 'text' && part.text?.trim())
          ) {
            const nativeStatus = await runtime!.client.request<Record<string, { type: string }>>(
              '/session/status',
              'GET',
              undefined,
              signal
            )
            if (['busy', 'retry'].includes(nativeStatus[nativeId!]?.type)) {
              // A continuation can persist its empty assistant placeholder
              // before an old cleanup idle is consumed. It is still running,
              // not an empty terminal answer; keep observing the same task.
              awaitingNativeRun = true
              return false
            }
            // A tool result or preliminary response may already be visible.
            // Completion still needs an answer from this continuation.
            throw Object.assign(
              new Error(
                backgroundResult
                  ? 'The assistant did not provide a final answer after receiving the background results; existing results were preserved'
                  : 'The assistant did not provide a final answer after skipping the repeated operation; existing results were preserved'
              ),
              {
                code: 'agent_missing_final_answer',
                zenFailureStage: 'agent-runtime'
              }
            )
          }
        }
        const followedByBackgroundResult = Boolean(
          backgroundResult &&
            latest?.parentID &&
            latest.parentID >= backgroundResult &&
            turnInput?.latestMessageId &&
            backgroundResult > turnInput.latestMessageId
        )
        if (
          atIdle &&
          turnInput?.hasAdditions &&
          latest?.parentID !== turnInput.latestMessageId &&
          !followedByBackgroundResult
        ) {
          const nativeStatus = await runtime!.client.request<Record<string, { type: string }>>(
            '/session/status',
            'GET',
            undefined,
            signal
          )
          if (nativeStatus[nativeId!]?.type === 'busy' || nativeStatus[nativeId!]?.type === 'retry') {
            awaitingNativeRun = true
            turnInput.ready(admitted)
            return false
          }
          // Native 1.x has a narrow final-read/idle race. Keep the addition in
          // history and surface it as awaiting continuation, never pretend it
          // was processed or replay it automatically.
          turnInput.reconcile(messages, true)
          return admitted && Boolean(latest?.time?.completed) && state.hasVisibleOutput
        }
        return (
          admitted &&
          Boolean(latest?.time?.completed) &&
          state.hasVisibleOutput &&
          (!turnInput?.hasAdditions || latest?.parentID === turnInput.latestMessageId || followedByBackgroundResult)
        )
      }
      const noteIdle = () => {
        idlePending = true
        turnInput?.ready(false)
      }
      const settleIdle = async () => {
        if (permissionError) throw permissionError
        if (permissionTasks.size) return
        idlePending = false
        const reconciled = await reconcile(true)
        if (permissionError) throw permissionError
        // The independent permission watcher can discover another prompt during reconciliation.
        if (permissionTasks.size) idlePending = true
        else completed = reconciled
      }
      const permission = async (props: OpenCodeEvent['properties']) => {
        if (permissionSignal.aborted || completed || pendingPermissions.has(props.id)) return
        pendingPermissions.add(props.id)
        if (props.permission === 'task') {
          const call = props.tool?.callID
          const key = `${session.id}:${call}`
          const allowed =
            typeof call === 'string' &&
            props.sessionID === nativeId &&
            (await subagents?.admit(
              key,
              String(props.metadata?.description ?? ''),
              String(props.metadata?.subagent_type ?? '')
            ))
          try {
            await runtime!.client.request(
              `/permission/${encodeURIComponent(props.id)}/reply`,
              'POST',
              {
                reply: allowed ? 'once' : 'reject',
                ...(!allowed
                  ? {
                      message:
                        'Child task scope or per-turn admission limit does not permit this delegation. Continue with existing results or perform the remaining work directly.'
                    }
                  : {})
              },
              permissionSignal
            )
          } catch (error) {
            subagents?.finish(key, 'failed')
            if (loopRecovery.waiting && typeof error === 'object' && error && 'status' in error && error.status === 404)
              return
            throw error
          }
          return
        }
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
        if (props.sessionID === nativeId && isInvalidReadToolLoop(props.permission, props.metadata)) {
          loopRecovery.reject(props.id, props.metadata.tool, props.metadata.input, 'invalid-arguments')
          await subagents?.cancelBackground()
          subagents?.cancelCurrent()
          turnInput?.ready(false)
          for (const controller of approvalControllers.values())
            controller.abort('Invalid repeated tool arguments; native generation interrupted')
          // Reject, never grant: no malformed invocation or side effect is
          // authorized. Native abort/idle remains the continuation barrier.
          await runtime!.client.request(
            `/permission/${encodeURIComponent(props.id)}/reply`,
            'POST',
            {
              reply: 'reject',
              message: 'Required read-only tool arguments are invalid; correct them before continuing.'
            },
            permissionSignal
          )
          recordMainDiagnostic(options?.diagnosticId, 'runtime', 'invalid-tool-loop-skipped', {
            runtime: 'opencode',
            requestId: props.id,
            toolName: props.metadata.tool
          })
          return
        }
        permissions++
        const approvalController = new AbortController()
        approvalControllers.set(props.id, approvalController)
        const approvalSignal = AbortSignal.any([permissionSignal, approvalController.signal])
        deadline.wait(`permission:${props.id}`)
        clearRetryBudget()
        status('waiting_permission')
        const permissionToolCallId = `${subagents?.toolCallPrefix(props.sessionID || nativeId!) ?? session.id}:${props.tool?.callID || `permission:${props.id}`}`
        subagents?.waitingFor(props.sessionID, 'waiting_permission')
        recordMainDiagnostic(options?.diagnosticId, 'runtime', 'permission-requested', {
          runtime: 'opencode',
          permission: props.permission,
          requestId: props.id,
          toolCallId: permissionToolCallId,
          linkedTool: Boolean(props.tool?.callID)
        })
        try {
          const result = await promptForToolApproval(
            props.permission,
            { ...props.metadata, patterns: props.patterns },
            {
              signal: approvalSignal,
              toolCallId: permissionToolCallId
            }
          )
          if (approvalSignal.aborted) return
          if (
            props.sessionID === nativeId &&
            props.permission === 'doom_loop' &&
            result.behavior === 'deny' &&
            result.decisionSource === 'response'
          ) {
            loopRecovery.reject(props.id, props.metadata?.tool, props.metadata?.input)
            await subagents?.cancelBackground()
            subagents?.cancelCurrent()
            turnInput?.ready(false)
            // Native rejection clears every pending permission in this session.
            // Remove sibling UI prompts too; never submit their aborted replies.
            for (const [id, controller] of approvalControllers) {
              if (id !== props.id) controller.abort('Repeated operation skipped; native generation interrupted')
            }
          }
          await runtime!.client.request(
            `/permission/${encodeURIComponent(props.id)}/reply`,
            'POST',
            {
              reply: result.behavior === 'allow' ? 'once' : 'reject',
              ...(result.behavior === 'deny' ? { message: result.message } : {})
            },
            approvalSignal
          )
          recordMainDiagnostic(options?.diagnosticId, 'runtime', 'permission-resolved', {
            runtime: 'opencode',
            permission: props.permission,
            requestId: props.id,
            toolCallId: permissionToolCallId,
            behavior: result.behavior
          })
        } catch (error) {
          if (!approvalSignal.aborted) throw error
        } finally {
          approvalControllers.delete(props.id)
          permissions--
          subagents?.waitingFor(props.sessionID, 'running')
          deadline.continue(`permission:${props.id}`)
          if (!permissionSignal.aborted) status(permissions > 0 ? 'waiting_permission' : 'busy')
        }
      }
      const requestPermission = (props: OpenCodeEvent['properties']) => {
        if (loopRecovery.waiting) return
        const task = permission(props).catch((error) => {
          if (permissionSignal.aborted) return
          permissionError = error
          eventController.abort('permission reply failed')
        })
        trackPermission(task)
      }
      const requestQuestion = (props: OpenCodeEvent['properties']) => {
        if (completed || permissionSignal.aborted || pendingQuestions.has(props.id)) return
        pendingQuestions.add(props.id)
        const key = `question:${props.id}`
        const task = (async () => {
          if (getAutomationProfile(session) || typeof props.tool?.callID !== 'string') {
            await runtime!.client.request(
              `/question/${encodeURIComponent(props.id)}/reject`,
              'POST',
              {},
              permissionSignal
            )
            return
          }
          permissions++
          activeQuestions++
          const questionController = new AbortController()
          approvalControllers.set(key, questionController)
          const questionSignal = AbortSignal.any([permissionSignal, questionController.signal])
          deadline.wait(key)
          clearRetryBudget()
          status('waiting_answer')
          subagents?.waitingFor(props.sessionID, 'waiting_answer')
          try {
            await answerOpenCodeQuestion({
              question: props as OpenCodeQuestion,
              client: runtime!.client,
              signal: questionSignal,
              toolCallId: `${subagents?.toolCallPrefix(props.sessionID) ?? session.id}:${props.tool.callID}`,
              ask: promptForToolApproval
            })
          } catch (error) {
            if (!questionSignal.aborted) throw error
          } finally {
            approvalControllers.delete(key)
            permissions--
            activeQuestions--
            deadline.continue(key)
            subagents?.waitingFor(props.sessionID, 'running')
            if (!permissionSignal.aborted) status(permissions ? 'waiting_permission' : 'busy')
          }
        })().catch((error) => {
          if (!permissionSignal.aborted) {
            permissionError = error
            eventController.abort('question reply failed')
          }
        })
        trackPermission(task)
      }
      const handle = async (event: OpenCodeEvent) => {
        const props = event.properties
        const eventSession = props.sessionID || props.info?.sessionID || props.part?.sessionID
        if (eventSession && eventSession !== nativeId) {
          if (!(await subagents?.owns(eventSession))) return
          if (event.type === 'permission.asked') requestPermission(props)
          if (event.type === 'question.asked') requestQuestion(props)
          const childChunks = subagents!.child(event, eventSession)
          timing.chunks(childChunks)
          if (
            childChunks.some(
              (chunk) =>
                ['tool-call', 'tool-result', 'tool-error'].includes(chunk.type) ||
                ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text.length > 0)
            )
          )
            deadline.progress()
          for (const chunk of childChunks)
            if (['tool-call', 'tool-result', 'tool-error'].includes(chunk.type)) emit(chunk)
          return
        }
        if (event.type === 'message.part.updated' && !state.previousMessages.has(props.part?.messageID))
          await subagents?.observeParent(props.part)
        timing.nativeEvent()
        if (event.type === 'message.updated' && props.info?.id === messageId) {
          admitted = true
          turnInput?.ready(true)
        }
        if (event.type === 'message.updated' && props.info?.summary && !state.previousMessages.has(props.info.id)) {
          compacting = true
          clearRetryBudget()
          status('compacting')
        }
        if (event.type === 'session.error') {
          if (props.error?.name === 'ContextOverflowError' && typeof props.error.data?.message === 'string') {
            // Native 1.19.5 publishes this BEFORE starting its own compaction.
            // Observe that same run; do not abort it or submit the task again.
            pendingOverflow = props.error
            overflowMessages = new Set(state.messages.keys())
            if (++consecutiveOverflows > 3) throw this.nativeError(pendingOverflow)
            compacting = true
            clearRetryBudget()
            status('compacting')
            recordMainDiagnostic(options?.diagnosticId, 'runtime', 'native-context-recovery', {
              runtime: 'opencode',
              attempt: consecutiveOverflows
            })
          } else if (!loopRecovery.expects(props.error)) throw this.nativeError(props.error)
          // Wait for native idle/cleanup before continuing, not a generic retry.
          transportFailure = undefined
        }
        if (event.type === 'server.instance.disposed')
          throw new Error('OpenCode local instance was disposed during the task')
        if (event.type === 'permission.asked') requestPermission(props)
        if (event.type === 'question.asked') requestQuestion(props)
        if (event.type === 'session.compacted') {
          const history = await runtime!.client.request<CompactionEntry[]>(
            `/session/${nativeId}/message`,
            'GET',
            undefined,
            signal
          )
          await verifyCompaction(history, 'during-task', true)
          compacting = false
          const checkpoint = history.findLast(
            (entry) =>
              entry.info.role === 'assistant' &&
              entry.info.summary &&
              entry.info.finish &&
              !entry.info.error &&
              !state.previousMessages.has(entry.info.id) &&
              entry.parts.some((part) => part.type === 'text' && part.text?.trim())
          )
          if (checkpoint && !completedCompactions.has(checkpoint.info.id)) {
            completedCompactions.add(checkpoint.info.id)
            const progress: Chunk = {
              type: 'raw',
              rawValue: { type: 'opencode_internal_progress', stage: 'compacting', kind: 'completed', characters: 0 }
            }
            timing.chunks([progress])
            emit(progress)
          }
          status('busy')
          recordMainDiagnostic(options?.diagnosticId, 'runtime', 'native-compacted', { runtime: 'opencode' })
        }
        if (event.type === 'session.status') {
          const next = props.status
          if (next?.type === 'busy') {
            clearRetryBudget()
            idlePending = false
            turnInput?.ready(admitted)
            observedBusy = true
            status(permissions > 0 ? 'waiting_permission' : 'busy')
          }
          if (next?.type === 'retry' && !compacting && permissions === 0) {
            idlePending = false
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
          if (next?.type === 'idle' && admitted && observedBusy) {
            clearRetryBudget()
            noteIdle()
          }
        }
        const chunks = state.consume(event)
        if (compacting && chunks.some((chunk) => ['tool-call', 'text-delta', 'reasoning-delta'].includes(chunk.type))) {
          // A missed compaction-completed event must not leave real answers or
          // tool execution labelled as context preparation after reconnection.
          compacting = false
          status('busy')
        }
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
          if (
            !pendingOverflow ||
            chunks.some((chunk) => {
              if (chunk.type !== 'tool-call' && chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta')
                return false
              const message = (chunk.providerMetadata?.opencode as { message_id?: string } | undefined)?.message_id
              return Boolean(message && !overflowMessages.has(message))
            })
          )
            consecutiveOverflows = 0
          transportFailure = undefined
          clearRetryBudget()
        }
        for (const chunk of chunks) emit(chunk)
      }
      stopPermissionWatcher = watchOpenCodePermissions({
        client: runtime.client,
        sessionId: nativeId,
        ownsSession: (id) => subagents!.owns(id),
        onQuestion: requestQuestion,
        signal: permissionSignal,
        hasUnfinishedTools: () => (unfinishedTools.size > 0 || !!subagents?.unfinished) && permissions === 0,
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
          let nextEvent: ReturnType<typeof iterator.next> | undefined
          while (!completed) {
            if (idlePending && !permissionTasks.size) {
              semanticFailure = true
              await settleIdle()
              if (completed) break
              if (!idlePending && !awaitingNativeRun)
                throw new Error('The new assistant returned an empty or incomplete result')
              semanticFailure = false
            }
            nextEvent ??= iterator.next()
            // Admission waits for child completion events. Continue consuming SSE while
            // waiting for replies, and wake here even if the acknowledgement is the last activity.
            let next: Awaited<typeof nextEvent> | undefined
            if (idlePending) {
              const idleReady = new Promise<undefined>((resolve) => {
                wakeIdle = () => resolve(undefined)
              })
              try {
                next = await Promise.race([nextEvent, idleReady])
              } finally {
                wakeIdle = undefined
              }
              if (!next) continue
            } else next = await nextEvent
            nextEvent = undefined
            if (next.done) throw new Error('OpenCode event stream ended before task completion')
            semanticFailure = true
            await handle(next.value)
            semanticFailure = false
          }
          eventController.abort('event observation complete')
          await iterator.return(undefined)
        } catch (error) {
          if (permissionError || signal.aborted || semanticFailure || eventController.signal.aborted) {
            eventController.abort('event observation stopped')
            await iterator.return(undefined).catch(() => undefined)
            throw permissionError || admissionError || error
          }
          // A broken local event connection is not a failed upstream task.
          // Reattach to that SAME task; never submit prompt_async a second time.
          const nativeStatus = await runtime.client.request<Record<string, { type: string }>>(
            '/session/status',
            'GET',
            undefined,
            signal
          )
          if (nativeStatus[nativeId]?.type === 'idle' || !nativeStatus[nativeId]) {
            noteIdle()
            // With no unfinished child, pending replies cannot depend on more child events.
            if (!subagents.unfinished) await Promise.all([...permissionTasks])
            await settleIdle()
            if (completed) break
            if (!idlePending && !awaitingNativeRun) throw admissionError || error
          } else idlePending = false
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
              if (await subagents.owns(pending.sessionID))
                await handle({ type: 'permission.asked', properties: pending })
            }
            const after = await runtime.client.request<Record<string, { type: string }>>(
              '/session/status',
              'GET',
              undefined,
              signal
            )
            observedBusy = true
            if (!after[nativeId] || after[nativeId].type === 'idle') {
              noteIdle()
              await settleIdle()
              if (!completed && !idlePending && !awaitingNativeRun)
                throw new Error('The new assistant returned an empty or incomplete result')
            } else idlePending = false
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
      if (eventReconnects > 0 || !usageTotals.hasCompleteUsage) {
        const recovered = (await subagents?.reconcile()) ?? []
        timing.chunks(recovered)
        for (const chunk of recovered) emit(chunk)
      }
      await runtime?.finishFileChanges?.()
      const quotaResult = await runtime?.finishTurn?.()
      if (quotaResult && shouldShowModelDailyQuotaNotice(quotaResult)) {
        emit({ type: 'raw', rawValue: { type: 'model_daily_quota', results: [quotaResult] } })
      }
      runtime?.flushDiagnostic()
      const diagnostics = publishDiagnostics('completed')
      emit({
        type: 'finish',
        totalUsage: usageTotals.completeUsage(sumUsage([state.usage(), ...(subagents?.usages() ?? [])])),
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
      subagents?.close(signal.aborted ? 'cancelled' : 'failed')
      runtime?.flushDiagnostic()
      runtime?.stop(signal.aborted ? 'task-aborted' : 'task-failed')
      await runtime?.finishFileChanges?.()
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
        if (transportFailure && !('zenFailureStage' in failure && failure.zenFailureStage === 'local-permission')) {
          Object.assign(failure, {
            zenTransportFailure: transportFailure,
            zenRequestUrl: transportFailure.url,
            zenFailureStage:
              transportFailure.phase === 'quota-admission'
                ? 'quota-admission'
                : transportFailure.receivedResponse
                  ? 'provider-stream'
                  : 'provider-connect'
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
      subagents?.close(completed ? 'cancelled' : signal.aborted ? 'cancelled' : 'failed')
      turnInput?.close()
      stopPermissionWatcher?.()
      deadline.dispose()
      clearTimeout(retryTimeout)
      clearInterval(heartbeat)
      eventController.abort('turn finished')
      signal.removeEventListener('abort', cancel)
      runtime?.setProgressListener(undefined)
      try {
        await runtime?.finishTurn?.()
      } finally {
        runtime?.release()
      }
    }
  }

  private nativeError(error: { name?: string; data?: { message?: string; statusCode?: number } } | undefined): Error {
    return Object.assign(new Error(diagnosticText(error?.data?.message || 'OpenCode native task failed')), {
      name: error?.name || 'OpenCodeError',
      status: error?.data?.statusCode,
      zenFailureStage: isNativePermissionRejection(error) ? 'local-permission' : 'agent-runtime',
      ...(isNativePermissionRejection(error) ? { code: 'agent_permission_denied' } : {}),
      zenRuntimeId: 'opencode'
    })
  }
}

function sumUsage(values: ReturnType<OpenCodeStreamState['usage']>[]) {
  const sum = (read: (value: (typeof values)[number]) => number | undefined) =>
    values.reduce((total, value) => total + (read(value) ?? 0), 0)
  return {
    inputTokens: sum((value) => value.inputTokens),
    outputTokens: sum((value) => value.outputTokens),
    totalTokens: sum((value) => value.totalTokens),
    inputTokenDetails: {
      noCacheTokens: sum((value) => value.inputTokenDetails?.noCacheTokens),
      cacheReadTokens: sum((value) => value.inputTokenDetails?.cacheReadTokens),
      cacheWriteTokens: sum((value) => value.inputTokenDetails?.cacheWriteTokens)
    },
    outputTokenDetails: {
      textTokens: sum((value) => value.outputTokenDetails?.textTokens),
      reasoningTokens: sum((value) => value.outputTokenDetails?.reasoningTokens)
    }
  }
}
