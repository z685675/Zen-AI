import { loggerService } from '@logger'
import type { CherryClawConfiguration, ScheduledTaskEntity } from '@types'

import { agentService } from './AgentService'
import type { ChannelAdapter } from './channels'
import { channelManager } from './channels/ChannelManager'
import { broadcastSessionChanged } from './channels/sessionStreamIpc'
import { channelService } from './ChannelService'
import { readHeartbeat } from './cherryclaw/heartbeat'
import { sessionMessageService } from './SessionMessageService'
import { sessionService } from './SessionService'
import { taskService } from './TaskService'

const logger = loggerService.withContext('SchedulerService')

const POLL_INTERVAL_MS = 60_000
const MAX_CONSECUTIVE_ERRORS = 3
const TASK_PAUSED_ABORT_REASON = 'Task paused by user'

const isBrowserWaitForUserTool = (toolName?: string): boolean => {
  if (!toolName) return false
  return toolName.includes('browser') && toolName.includes('wait_for_user')
}

type RunningTask = {
  taskId: string
  agentId: string
  abortController: AbortController
  completion: Promise<void>
}

type TaskRunTrigger = 'scheduled' | 'manual' | 'retry'

// TODO: refactor lifecycle in V2
class SchedulerService {
  private static instance: SchedulerService | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private readonly activeTasks = new Map<string, RunningTask>()
  private readonly consecutiveErrors = new Map<string, number>()
  static getInstance(): SchedulerService {
    if (!SchedulerService.instance) {
      SchedulerService.instance = new SchedulerService()
    }
    return SchedulerService.instance
  }

  startLoop(): void {
    if (this.running) {
      logger.debug('Scheduler loop already running')
      return
    }
    this.running = true
    logger.info('Scheduler poll loop started')
    this.poll()
  }

  stopLoop(): void {
    this.running = false
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    // Abort all running tasks
    for (const [taskId, rt] of this.activeTasks) {
      rt.abortController.abort()
      logger.info('Aborted running task on shutdown', { taskId })
    }
    this.activeTasks.clear()
    logger.info('Scheduler poll loop stopped')
  }

  /** Ensure the poll loop is running after agent config changes. */
  async syncScheduler(): Promise<void> {
    const hasActive = await taskService.hasActiveTasks()
    if (hasActive) {
      this.startLoop()
    } else {
      logger.debug('No active tasks, skipping scheduler start')
    }
  }

  stopAll(): void {
    this.stopLoop()
  }

  async restoreSchedulers(): Promise<void> {
    await taskService.recoverInterruptedTaskRuns()
    const hasActive = await taskService.hasActiveTasks()
    if (hasActive) {
      this.startLoop()
    } else {
      logger.debug('No active tasks found, scheduler not started')
    }
  }

  /**
   * Ensure a heartbeat task exists for the given agent.
   * Creates one if missing, or updates the interval if it changed.
   */
  async ensureHeartbeatTask(agentId: string, intervalMinutes: number = 30): Promise<void> {
    const { tasks } = await taskService.listTasks(agentId, { includeHeartbeat: true })
    const existing = tasks.find((t) => t.name === 'heartbeat')

    if (existing) {
      const currentInterval = existing.schedule_value
      const newInterval = String(intervalMinutes)
      if (currentInterval !== newInterval) {
        await taskService.updateTask(agentId, existing.id, { schedule_value: newInterval })
        logger.info('Updated heartbeat task interval', { agentId, interval: intervalMinutes })
      }
    } else {
      await taskService.createTask(agentId, {
        name: 'heartbeat',
        prompt: '__heartbeat__',
        schedule_type: 'interval',
        schedule_value: String(intervalMinutes)
      })
      logger.info('Created heartbeat task', { agentId, interval: intervalMinutes })
      this.startLoop()
    }
  }

  /**
   * Manually trigger a task run (from UI).
   *
   * The task itself still runs in the background, but this method waits until
   * the task conversation has been created and the renderer has been notified.
   * That gives the caller a reliable acknowledgement that the execution is
   * visible to the user instead of merely accepting a fire-and-forget promise.
   */
  async runTaskNow(agentId: string, taskId: string): Promise<void> {
    const task = await taskService.getTask(agentId, taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)

    const activeTask = this.activeTasks.get(task.id)
    if (activeTask) {
      if (task.status !== 'paused') throw new Error('Task is already running')

      // Pausing a task cancels the current run. Wait for its cleanup before
      // accepting a manual run so a paused task never gets stuck in limbo.
      activeTask.abortController.abort(TASK_PAUSED_ABORT_REASON)
      await activeTask.completion
    }

    // A paused task resumes as active, while a completed one-time task can be
    // run again without converting it into a recurring task. The final run
    // outcome will move it to completed or paused/error as appropriate.
    if (task.status === 'paused' || (task.schedule_type === 'once' && task.status === 'completed')) {
      await taskService.updateTask(agentId, taskId, { status: 'active' })
    }

    let resolveReady!: () => void
    let rejectReady!: (error: unknown) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    // Fire and forget after the run has been registered. Any failure before
    // the conversation is ready is propagated to the API caller.
    void this.runTask(task, 'manual', (_sessionId, error) => {
      if (error) {
        rejectReady(error)
      } else {
        resolveReady()
      }
    }).catch((error) => {
      rejectReady(error)
      logger.error('Unhandled error in manual runTask', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error)
      })
    })

    await ready
  }

  private poll(): void {
    if (!this.running) return

    this.tick()
      .catch((error) => {
        logger.error('Error in scheduler tick', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        if (this.running) {
          this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL_MS)
        }
      })
  }

  /** Update a task status and keep the in-memory scheduler state in sync. */
  async updateTaskStatus(agentId: string, taskId: string, status: 'active' | 'paused' | 'completed') {
    const task = await taskService.getTask(agentId, taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)

    const updatedTask = await taskService.updateTask(agentId, taskId, { status })
    if (!updatedTask) throw new Error(`Task not found: ${taskId}`)

    if (status === 'paused') {
      const activeTask = this.activeTasks.get(taskId)
      if (activeTask) {
        activeTask.abortController.abort(TASK_PAUSED_ABORT_REASON)
        await activeTask.completion
      }
    } else if (status === 'active') {
      this.startLoop()
    }

    return updatedTask
  }

  private async tick(): Promise<void> {
    const dueTasks = await taskService.getDueTasks()
    if (dueTasks.length > 0) {
      logger.info('Found due tasks', { count: dueTasks.length })
    }

    for (const task of dueTasks) {
      // Skip if already running
      if (this.activeTasks.has(task.id)) {
        logger.debug('Task already running, skipping', { taskId: task.id })
        continue
      }

      // Fire and forget — don't block the poll loop
      this.runTask(task, 'scheduled').catch((error) => {
        logger.error('Unhandled error in runTask', {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error)
        })
      })
    }
  }

  private async runTask(
    task: ScheduledTaskEntity,
    triggerType: TaskRunTrigger = 'scheduled',
    onReady?: (sessionId?: string, error?: unknown) => void
  ): Promise<void> {
    const startTime = Date.now()
    const abortController = new AbortController()
    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })
    const runningTask: RunningTask = {
      taskId: task.id,
      agentId: task.agent_id,
      abortController,
      completion
    }
    this.activeTasks.set(task.id, runningTask)

    // Set up timeout if configured
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    if (task.timeout_minutes && task.timeout_minutes > 0) {
      const timeoutMs = task.timeout_minutes * 60_000
      timeoutTimer = setTimeout(() => {
        logger.warn('Task timed out, aborting', { taskId: task.id, timeoutMinutes: task.timeout_minutes })
        abortController.abort(new Error(`Task timed out after ${task.timeout_minutes} minutes`))
      }, timeoutMs)
    }

    let result: string | null = null
    let error: string | null = null
    let pausedByUser = false
    let sessionId: string | undefined
    let resolvedModelId: string | null = task.model_id?.trim() || null
    let subscribedChannels: { id: string; sessionId?: string | null }[] = []
    let readyAcknowledged = false
    const acknowledgeReady = (readySessionId?: string) => {
      if (readyAcknowledged) return
      readyAcknowledged = true
      onReady?.(readySessionId)
    }

    // Create log entry immediately so UI shows the running task
    let logId: number
    try {
      logId = await taskService.logTaskRun({
        task_id: task.id,
        session_id: null,
        model_id: task.model_id?.trim() || null,
        trigger_type: triggerType,
        scheduled_for: task.next_run,
        run_at: new Date().toISOString(),
        duration_ms: 0,
        status: 'running',
        result: null,
        error: null
      })
    } catch (error) {
      this.activeTasks.delete(task.id)
      resolveCompletion()
      if (timeoutTimer) clearTimeout(timeoutTimer)
      throw error
    }

    try {
      logger.info('Running scheduled task', { taskId: task.id, agentId: task.agent_id })
      const agent = await agentService.getAgent(task.agent_id)
      if (!agent) {
        throw new Error(`Agent not found: ${task.agent_id}`)
      }

      const config = (agent.configuration ?? {}) as CherryClawConfiguration
      const workspacePath = agent.accessible_paths?.[0]

      // For heartbeat tasks, read prompt from workspace heartbeat.md file
      let fullPrompt = task.prompt
      if (task.name === 'heartbeat') {
        if (config.heartbeat_enabled === false || !workspacePath) {
          logger.debug('Heartbeat task skipped (disabled or no workspace)', { taskId: task.id })
          // Still update next_run so it doesn't fire again immediately
          const nextRun = taskService.computeNextRun(task)
          await taskService.updateTaskRunLog(logId, {
            status: 'success',
            result: 'Skipped (disabled)',
            duration_ms: Date.now() - startTime
          })
          await taskService.updateTaskAfterRun(task.id, nextRun, 'Skipped (disabled)', 'skipped')
          if (timeoutTimer) clearTimeout(timeoutTimer)
          this.activeTasks.delete(task.id)
          resolveCompletion()
          acknowledgeReady()
          return
        }
        const heartbeatContent = await readHeartbeat(workspacePath)
        if (!heartbeatContent) {
          logger.debug('Heartbeat task skipped (no heartbeat.md)', { taskId: task.id })
          const nextRun = taskService.computeNextRun(task)
          await taskService.updateTaskRunLog(logId, {
            status: 'success',
            result: 'Skipped (no file)',
            duration_ms: Date.now() - startTime
          })
          await taskService.updateTaskAfterRun(task.id, nextRun, 'Skipped (no file)', 'skipped')
          if (timeoutTimer) clearTimeout(timeoutTimer)
          this.activeTasks.delete(task.id)
          resolveCompletion()
          acknowledgeReady()
          return
        }
        fullPrompt = [
          '[Heartbeat]',
          'This is a periodic heartbeat. The instructions below are from your heartbeat.md file.',
          'Process each item, take action where possible, and use the notify tool to alert the user of important results.',
          '',
          '---',
          heartbeatContent
        ].join('\n')
      }

      // Resolve subscribed channels
      subscribedChannels = await channelService.getSubscribedChannels(task.id)

      fullPrompt = [
        '[Scheduled Task Execution Policy]',
        'Run this scheduled task in the background by default.',
        'Do not terminate the task at the first blocked node. If a command, dependency, current directory, login state, permission, website structure, or browser state is missing, first try an equivalent route, then pause with a concrete recovery path.',
        'If a local dependency such as Git, Python, Node, package managers, GitHub CLI, document tools, or conversion utilities is missing, decide whether it is truly required. If an alternative path exists, use it. If it is required, notify the user what is missing, why it is needed, and whether they should approve installation or follow official install steps.',
        'If a website requires login, CAPTCHA, 2FA, authorization, account access, final confirmation, upload/download choice, file picker, site check-in, dashboard/admin workflow, or manual browser interaction, open the Zen AI internal browser visibly with mcp__browser__open showWindow=true, notify the user with mcp__claw__notify when notification channels are available, then call mcp__browser__wait_for_user and continue only after the user clicks Continue.',
        'For simulated, dry-run, or high-impact operations such as publishing releases, submitting forms, posting announcements, changing remote settings, deleting remote resources, uploading public content, payment, or overwriting remote files, stop at draft/preview/pending-confirmation unless the user explicitly pre-authorized the final action.',
        'Do not bypass CAPTCHA, payment confirmation, security prompts, or website anti-abuse protections.',
        'For ordinary public web search, page reading, and report generation, keep the browser in background mode and do not claim that a visible browser was opened.',
        '',
        fullPrompt
      ].join('\n')

      // Recurring tasks keep one stable conversation for continuity. A
      // one-time rerun is a new execution and gets its own conversation so
      // every run can be opened independently from the history.
      const lastSessionId = task.schedule_type === 'once' ? null : await taskService.getLastRunSessionId(task.id)
      let session = lastSessionId ? await sessionService.getSession(task.agent_id, lastSessionId) : null
      const requestedModel = task.model_id?.trim() || undefined

      // A task-level model change must start a fresh session. Reusing the old
      // session here would silently continue sending requests to its model.
      if (session && requestedModel && session.model !== requestedModel) {
        logger.info('Task model changed; creating a fresh session', {
          taskId: task.id,
          previousModel: session.model,
          requestedModel
        })
        session = null
      }

      const scheduledTaskMetadata = {
        task_id: task.id,
        task_name: task.name,
        run_log_id: logId,
        trigger_type: triggerType,
        scheduled_for: task.next_run
      }

      if (session) {
        sessionId = session.id
        resolvedModelId = session.model
        await sessionService.updateSession(task.agent_id, session.id, {
          configuration: {
            ...config,
            ...session.configuration,
            scheduled_task: scheduledTaskMetadata
          } as CherryClawConfiguration
        })
        logger.debug('Reusing session from last run', { taskId: task.id, sessionId })
      } else {
        const newSession = await sessionService.createSession(task.agent_id, {
          name: task.name,
          ...(requestedModel ? { model: requestedModel } : {}),
          configuration: {
            ...config,
            scheduled_task: scheduledTaskMetadata
          }
        })
        const createdSessionId = newSession?.id
        if (!createdSessionId) {
          throw new Error('Task session was not created')
        }
        session = await sessionService.getSession(task.agent_id, createdSessionId)
        if (!session) {
          throw new Error(`Session not found: ${createdSessionId}`)
        }
        sessionId = session.id
        resolvedModelId = session.model
        broadcastSessionChanged(task.agent_id, sessionId, true, 'created')
        logger.debug('Created new session for task', { taskId: task.id, sessionId })
      }

      // Send as user message (triggers agent response)
      const { stream, completion } = await sessionMessageService.createSessionMessage(
        session,
        { content: fullPrompt },
        abortController,
        { persist: true }
      )
      // The manual trigger is acknowledged only after the session exists and
      // the task message has been accepted for persistence. A visible session
      // without a submitted task would be a misleading success signal.
      acknowledgeReady(sessionId)

      // Collect the response text and stream to subscribed channels only
      let waitingForUser = false
      const targetAdapters = subscribedChannels
        .map((ch) => {
          const adapter = channelManager.getAdapter(ch.id)
          logger.info('Task stream channel check', {
            channelId: ch.id,
            hasAdapter: !!adapter,
            notifyChatIds: adapter?.notifyChatIds ?? []
          })
          return adapter
        })
        .filter((a) => a !== undefined)
      const responseText = await this.collectAndStreamResponse(stream, targetAdapters, {
        onWaitingForUser: async () => {
          if (waitingForUser) return
          waitingForUser = true
          await taskService.updateTaskRunLog(logId, {
            status: 'waiting_user',
            result: 'Waiting for user browser handoff'
          })
        },
        onResumedFromUser: async () => {
          if (!waitingForUser) return
          waitingForUser = false
          await taskService.updateTaskRunLog(logId, {
            status: 'running',
            result: 'Resumed after user browser handoff'
          })
        }
      })
      await completion

      // Check if the task was aborted (e.g. by timeout)
      if (abortController.signal.aborted) {
        const reason = abortController.signal.reason
        throw reason instanceof Error ? reason : new Error(String(reason ?? 'Task aborted'))
      }

      result = responseText.slice(0, 200) || 'Completed'
      this.consecutiveErrors.delete(task.id)
      logger.info('Task completed', { taskId: task.id, durationMs: Date.now() - startTime })
    } catch (err) {
      pausedByUser = abortController.signal.reason === TASK_PAUSED_ABORT_REASON
      if (pausedByUser) {
        result = 'Task paused by user'
        logger.info('Task paused by user', { taskId: task.id })
      } else {
        error = err instanceof Error ? err.message : String(err)
        logger.error('Task failed', { taskId: task.id, error })

        // Track consecutive errors across invocations
        const errCount = (this.consecutiveErrors.get(task.id) ?? 0) + 1
        this.consecutiveErrors.set(task.id, errCount)
        if (errCount >= MAX_CONSECUTIVE_ERRORS) {
          logger.warn('Pausing task after consecutive errors', {
            taskId: task.id,
            errors: errCount
          })
          await taskService.updateTask(task.agent_id, task.id, { status: 'paused' })
          this.consecutiveErrors.delete(task.id)
        }
      }
      if (onReady && !readyAcknowledged) {
        readyAcknowledged = true
        onReady(undefined, err)
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
    }

    try {
      const durationMs = Date.now() - startTime

      // Persist the final log state before telling the scheduler that this run
      // is over. This keeps pause/resume/manual rerun state transitions ordered.
      await taskService.updateTaskRunLog(logId, {
        session_id: sessionId ?? null,
        model_id: resolvedModelId,
        duration_ms: durationMs,
        status: pausedByUser ? 'paused' : error ? 'error' : 'success',
        result,
        error
      })

      // Compute next run and update task
      const nextRun = taskService.computeNextRun(task)
      const resultSummary = error ? `Error: ${error}` : result ? result.slice(0, 200) : 'Completed'
      await taskService.updateTaskAfterRun(
        task.id,
        nextRun,
        resultSummary,
        pausedByUser ? 'skipped' : error ? 'error' : 'success'
      )

      // Refresh the visible session list after the final run state is saved.
      // The created event above handles immediate visibility; this event
      // refreshes the conversation contents and fulfilled state.
      if (sessionId) {
        broadcastSessionChanged(task.agent_id, sessionId, true)
      }

      // Send error notification or final response to channels
      if (error) {
        await this.notifyTaskError(task, durationMs, error, subscribedChannels)
      }
    } finally {
      this.activeTasks.delete(task.id)
      resolveCompletion()
    }
  }

  /**
   * Collect the stream response text and simultaneously stream to channel adapters.
   * Mirrors the logic in ChannelMessageHandler.collectStreamResponse.
   */
  private async collectAndStreamResponse(
    stream: ReadableStream,
    adapters: ChannelAdapter[],
    callbacks?: {
      onWaitingForUser?: () => Promise<void>
      onResumedFromUser?: () => Promise<void>
    }
  ): Promise<string> {
    const reader = stream.getReader()
    let completedText = ''
    let currentBlockText = ''

    // Pick the first notifyChatId from each adapter for streaming
    const adapterChats = adapters.flatMap((a) => a.notifyChatIds.map((chatId) => ({ adapter: a, chatId })))

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        // Skip user message echoes
        const rawType = value.providerMetadata?.raw?.type
        if (rawType === 'user') continue

        switch (value.type) {
          case 'tool-call':
            if (isBrowserWaitForUserTool(value.toolName)) {
              await callbacks?.onWaitingForUser?.()
            }
            break
          case 'tool-result':
            if (isBrowserWaitForUserTool(value.toolName)) {
              await callbacks?.onResumedFromUser?.()
            }
            break
          case 'text-delta':
            if (value.text) {
              currentBlockText = value.text
              const fullText = completedText + currentBlockText
              // Stream to all channel adapters
              for (const { adapter, chatId } of adapterChats) {
                adapter.onTextUpdate(chatId, fullText).catch(() => {})
              }
            }
            break
          case 'text-end':
            if (currentBlockText) {
              completedText += currentBlockText + '\n\n'
              currentBlockText = ''
            }
            break
        }
      }

      const finalText = (completedText + currentBlockText).replace(/\n+$/, '')

      // Finalize streaming on all adapters, fall back to sendMessage if not handled
      for (const { adapter, chatId } of adapterChats) {
        try {
          const handled = await adapter.onStreamComplete(chatId, finalText)
          if (!handled && finalText) {
            await adapter.sendMessage(chatId, finalText)
          }
        } catch (err) {
          logger.warn('Failed to send task response to channel', {
            channelId: adapter.channelId,
            chatId,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }

      return finalText
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      for (const { adapter, chatId } of adapterChats) {
        adapter.onStreamError(chatId, errorMsg).catch(() => {})
      }
      throw error
    }
  }

  private async notifyTaskError(
    task: ScheduledTaskEntity,
    durationMs: number,
    error: string,
    subscribedChannels: { id: string; sessionId?: string | null }[]
  ): Promise<void> {
    try {
      if (subscribedChannels.length === 0) return

      const durationSec = Math.round(durationMs / 1000)
      const text = `[Task failed] ${task.name}\nDuration: ${durationSec}s\nError: ${error}`

      for (const ch of subscribedChannels) {
        const adapter = channelManager.getAdapter(ch.id)
        logger.info('Task notification channel check', {
          channelId: ch.id,
          hasAdapter: !!adapter,
          notifyChatIds: adapter?.notifyChatIds ?? []
        })
        if (!adapter) continue
        for (const chatId of adapter.notifyChatIds) {
          adapter.sendMessage(chatId, text).catch((err) => {
            logger.warn('Failed to send task error notification', {
              taskId: task.id,
              channelId: ch.id,
              chatId,
              error: err instanceof Error ? err.message : String(err)
            })
          })
        }
      }
    } catch (err) {
      logger.warn('Error sending task error notification', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

export const schedulerService = SchedulerService.getInstance()
