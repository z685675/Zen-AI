import { type ChildProcess, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { loggerService } from '@logger'
import {
  cleanupAssistantMcpContext,
  registerAssistantMcpContext,
  touchAssistantMcpContext
} from '@main/apiServer/routes/assistant-mcp'
import {
  cleanupBrowserMcpContext,
  registerBrowserMcpContext,
  touchBrowserMcpContext
} from '@main/apiServer/routes/browser-mcp'
import { configManager } from '@main/services/ConfigManager'
import { recordMainDiagnostic } from '@main/services/DiagnosticEvidenceService'
import { getDataPath, getResourcePath, toAsarUnpackedPath } from '@main/utils'
import { getBinaryPath } from '@main/utils/process'
import { isZenManagedApiHost } from '@shared/config/zenProvider'
import { app } from 'electron'

import { assertAssistantDataAvailable } from '../dataOperationGate'
import { buildOpenCodeAuditHeaders } from './audit'
import { OpenCodeClient } from './client'
import { buildOpenCodeEnvironment, OPENCODE_PROVIDER_ID, OPENCODE_VERSION } from './config'
import { resolveOpenCodeExecutable } from './executable'
import { createOpenCodeGateway } from './gateway'
import { prepareOpenCodeOfflineConfig } from './offline'
import { collectRuntimeSecrets, OpenCodeStderr } from './stderr'

export { resolveOpenCodeExecutable } from './executable'

const logger = loggerService.withContext('OpenCodeProcess')
const processes = new Map<string, OpenCodeProcess>()
const reservations = new Set<string>()
let skillMutation = false
let shuttingDown = false
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export class OpenCodeProcess {
  client!: OpenCodeClient
  private child?: ChildProcess
  private closed = false
  private idleTimer?: ReturnType<typeof setTimeout>
  private gateway?: Awaited<ReturnType<typeof createOpenCodeGateway>>
  private progressListener?: (event: string, details: Record<string, unknown>) => void
  private turnSignal?: AbortSignal
  private diagnosticId?: string
  private stderr = new OpenCodeStderr()
  private diagnosticSecrets: string[] = []
  private stderrCollectionFailed = false
  private startupPhase = 'not-started'
  private executable?: string
  private observedVersion?: string
  private stopReason?: string
  active = true
  get ready(): boolean {
    return this.startupPhase === 'ready' && !this.closed
  }
  skillsStale = false
  nativeSessionId?: string

  constructor(
    readonly key: string,
    readonly directory: string,
    readonly configHash: string
  ) {}

  private get root() {
    return path.join(getDataPath('OpenCode'), hash(this.key))
  }
  private get bindingPath() {
    return path.join(this.root, 'binding.json')
  }

  async start(config: unknown, allowedRoots: string[], signal: AbortSignal, dailyModel?: string): Promise<void> {
    try {
      await this.startNative(config, allowedRoots, signal, dailyModel)
    } catch (error) {
      this.flushDiagnostic()
      this.recordDiagnostic('failed', {
        startup: !signal.aborted,
        cancelled: signal.aborted,
        phase: this.startupPhase,
        error
      })
      this.stop(signal.aborted ? 'startup-cancelled' : 'startup-failed')
      throw error
    }
  }

  private stage(phase: string) {
    this.startupPhase = phase
    this.recordDiagnostic('startup-stage', { phase })
  }

  private recordDiagnostic(event: string, details: Record<string, unknown> = {}) {
    try {
      recordMainDiagnostic(this.diagnosticId, 'runtime', event, { runtime: 'opencode', ...details })
    } catch {
      /* Diagnostic collection cannot stop the task. */
    }
  }

  flushDiagnostic() {
    try {
      this.recordDiagnostic('process-snapshot', {
        expectedVersion: OPENCODE_VERSION,
        observedVersion: this.observedVersion,
        phase: this.startupPhase,
        executable: this.executable,
        pid: this.child?.pid,
        closed: this.closed,
        active: this.active,
        stopReason: this.stopReason,
        stderr: { ...this.stderr.snapshot(), collectionFailed: this.stderrCollectionFailed }
      })
    } catch {
      this.recordDiagnostic('process-snapshot', { collectionStatus: 'failed' })
    }
  }

  flushMatchingDiagnostic(id: string): void {
    if (this.diagnosticId === id) this.flushDiagnostic()
  }

  private async startNative(
    config: unknown,
    allowedRoots: string[],
    signal: AbortSignal,
    dailyModel?: string
  ): Promise<void> {
    this.stage('workspace')
    signal.throwIfAborted()
    await fs.access(this.directory)
    await Promise.all(
      ['home', 'config/opencode', 'data', 'cache', 'state'].map((part) =>
        fs.mkdir(path.join(this.root, part), { recursive: true })
      )
    )
    signal.throwIfAborted()
    this.stage('offline-resources')
    await prepareOpenCodeOfflineConfig(
      this.root,
      app.isPackaged
        ? path.join(process.resourcesPath, 'opencode-runtime')
        : toAsarUnpackedPath(path.join(getResourcePath(), 'opencode-runtime'))
    )
    this.turnSignal = signal
    const productConfig = config as { permission?: Record<string, unknown> }
    const lightweight =
      productConfig.permission?.mcp__assistant__python_execute === 'deny' ||
      (productConfig.permission?.['*'] === 'deny' && productConfig.permission?.bash === 'deny')
    const getTurnSignal = () => this.turnSignal
    registerAssistantMcpContext(this.key, allowedRoots, {
      workspace: this.directory,
      get signal() {
        return getTurnSignal()
      },
      readOnly: !lightweight && productConfig.permission?.edit === 'deny',
      allowedTools: lightweight
        ? ['create_file', 'read_document', 'present_files', 'ocr_file', 'web_search']
        : undefined,
      readNativeSkills: (requestSignal) => this.client.request('/skill', 'GET', undefined, requestSignal),
      approveOverwrite: async (file) => {
        if (productConfig.permission?.edit === 'deny') return false
        // Automatic execution is not consent to replace an existing user file.
        const { confirmAssistantFileOverwrite } = await import('./fileApproval')
        return confirmAssistantFileOverwrite(file, this.turnSignal ?? signal)
      },
      onTool: (name, durationMs, failed) =>
        recordMainDiagnostic(this.diagnosticId, 'runtime', 'product-tool-complete', {
          runtime: 'opencode',
          tool: name,
          durationMs,
          failed
        })
    })
    if (!lightweight) registerBrowserMcpContext(this.key)
    const password = randomBytes(32).toString('hex')
    const env = buildOpenCodeEnvironment(process.env, this.root, password, await getBinaryPath())
    const expected = JSON.parse(JSON.stringify(config)) as Record<string, any>
    const providerOptions = expected.provider[OPENCODE_PROVIDER_ID].options
    const providerHost = providerOptions.baseURL as string
    this.stage('local-gateway')
    this.gateway = await createOpenCodeGateway(
      providerOptions.baseURL,
      (id, event, details) => {
        recordMainDiagnostic(id, 'transport', event, details)
        // Status callbacks are scoped to the active turn and cannot alter bytes.
        this.progressListener?.(event, details)
      },
      dailyModel ??
        (isZenManagedApiHost(providerHost)
          ? String(expected.model).slice(`${OPENCODE_PROVIDER_ID}/`.length)
          : undefined)
    )
    providerOptions.baseURL = this.gateway.baseURL
    let auditClientId = ''
    try {
      auditClientId = configManager.getClientId()
    } catch {
      // Optional audit metadata must not prevent a native task from starting.
      this.recordDiagnostic('client-identity-unavailable')
    }
    providerOptions.headers = {
      ...providerOptions.headers,
      'x-zen-runtime-token': this.gateway.token,
      ...buildOpenCodeAuditHeaders(providerHost, auditClientId, app.getVersion(), `${process.platform}-${process.arch}`)
    }
    try {
      this.diagnosticSecrets = [password, this.gateway.token, ...collectRuntimeSecrets(expected)]
      this.stderr = new OpenCodeStderr(this.diagnosticSecrets)
    } catch {
      // Disable stderr rather than collect it without all known credential masks.
      this.stderrCollectionFailed = true
    }
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(expected)
    signal.throwIfAborted()
    this.stage('executable-resolution')
    this.executable = resolveOpenCodeExecutable()
    this.stage('process-spawn')
    const child = spawn(
      this.executable,
      ['serve', '--hostname=127.0.0.1', '--port=0', '--no-mdns', '--pure', '--log-level=WARN'],
      {
        cwd: this.directory,
        env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    this.child = child
    this.recordDiagnostic('process-spawned', { pid: child.pid, executable: this.executable, version: OPENCODE_VERSION })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.stderrCollectionFailed) return
      try {
        this.stderr.append(chunk)
      } catch {
        this.stderrCollectionFailed = true
        /* Never interrupt the native pipe or task for diagnostics. */
      }
    })
    child.on('error', (error) => {
      this.flushDiagnostic()
      this.recordDiagnostic('process-error', {
        error,
        phase: this.startupPhase,
        requestedStop: Boolean(this.stopReason)
      })
    })
    child.once('exit', (code, exitSignal) => {
      const unexpected = !this.closed
      const active = this.active
      this.flushDiagnostic()
      this.recordDiagnostic('process-exit', {
        code,
        signal: exitSignal,
        unexpected,
        active,
        phase: this.startupPhase,
        stopReason: this.stopReason
      })
    })
    child.once('close', (code, exitSignal) => {
      this.flushDiagnostic()
      this.recordDiagnostic('process-close', { code, signal: exitSignal, stopReason: this.stopReason })
    })
    const stopOnAbort = () => this.stop('startup-cancelled')
    signal.addEventListener('abort', stopOnAbort, { once: true })
    try {
      this.stage('server-listen')
      const address = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error('OpenCode startup timed out')), 30_000)
        let output = ''
        const onError = (error: Error) => finish(error)
        const onExit = () => finish(new Error('OpenCode process exited during startup'))
        const onAbort = () => finish(new Error('OpenCode startup cancelled'))
        const onData = (data: Buffer) => {
          output = (output + data.toString()).slice(-16_384)
          const match = output.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/)
          if (match) finish(undefined, match[1])
        }
        const finish = (error?: Error, url?: string) => {
          clearTimeout(timeout)
          child.off('error', onError)
          child.off('exit', onExit)
          child.stdout?.off('data', onData)
          signal.removeEventListener('abort', onAbort)
          if (error) reject(error)
          else resolve(url!)
        }
        child.once('error', onError)
        child.once('exit', onExit)
        child.stdout?.on('data', onData)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
      child.stdout?.resume()
      child.on('error', () => this.stop('process-error'))
      child.once('exit', (code) => {
        const active = this.active
        const unexpected = !this.closed
        if (code && active && unexpected)
          logger.warn('OpenCode exited during a task', {
            code,
            version: OPENCODE_VERSION,
            operationId: this.diagnosticId
          })
        this.stop('unexpected-exit')
      })
      this.client = new OpenCodeClient(address, password, this.directory)
      this.stage('health-check')
      const health = await this.client.request<{ healthy: boolean; version: string }>(
        '/global/health',
        'GET',
        undefined,
        signal
      )
      this.observedVersion = health.version
      this.recordDiagnostic('process-health', {
        healthy: health.healthy,
        observedVersion: health.version,
        expectedVersion: OPENCODE_VERSION
      })
      if (!health.healthy || health.version !== OPENCODE_VERSION) throw new Error('Unexpected OpenCode runtime version')
      this.stage('configuration-check')
      const effective = await this.client.request<Record<string, any>>('/config', 'GET', undefined, signal)
      for (const key of ['provider', 'mcp', 'permission', 'skills', 'enabled_providers', 'plugin']) {
        if (!isDeepStrictEqual(effective[key], expected[key]))
          throw new Error(`OpenCode managed configuration override detected: ${key}`)
      }
      this.stage('history-binding')
      const binding = await fs
        .readFile(this.bindingPath, 'utf8')
        .then((data) => JSON.parse(data))
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw new Error('New assistant native session binding is unreadable; history was not reset')
        })
      if (binding && binding.directory !== this.directory)
        throw new Error('New assistant workspace changed; original history was not reset')
      if (binding && typeof binding.id !== 'string') throw new Error('Invalid new assistant session binding')
      this.nativeSessionId = binding?.id
      signal.throwIfAborted()
      this.stage('ready')
      logger.info('OpenCode local runtime ready', { version: OPENCODE_VERSION })
    } catch (error) {
      this.stop(signal.aborted ? 'startup-cancelled' : 'startup-failed')
      throw error
    } finally {
      signal.removeEventListener('abort', stopOnAbort)
    }
  }

  async session(signal: AbortSignal): Promise<string> {
    if (this.nativeSessionId) {
      await this.client.request(`/session/${encodeURIComponent(this.nativeSessionId)}`, 'GET', undefined, signal)
      return this.nativeSessionId
    }
    const native = await this.client.request<{ id: string }>(
      '/session',
      'POST',
      { title: 'Zen AI New Assistant' },
      signal
    )
    await this.bindSession(native.id)
    return native.id
  }

  async bindSession(id: string): Promise<void> {
    const temp = this.bindingPath + '.tmp'
    await fs.writeFile(temp, JSON.stringify({ id, directory: this.directory, version: OPENCODE_VERSION }), {
      mode: 0o600
    })
    await fs.rename(temp, this.bindingPath)
    this.nativeSessionId = id
  }

  async stopAndWait(): Promise<void> {
    const child = this.child
    const exited =
      !child || child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Native process did not stop; history was not copied')),
              10_000
            )
            child.once('exit', () => {
              clearTimeout(timer)
              resolve()
            })
          })
    this.stop()
    await exited
  }

  release() {
    this.active = false
    if (this.closed) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop('idle-timeout'), 5 * 60_000)
    this.idleTimer.unref()
    touchAssistantMcpContext(this.key)
    touchBrowserMcpContext(this.key)
  }

  async finishTurn() {
    await this.gateway?.finishTurn()
  }

  activate() {
    clearTimeout(this.idleTimer)
    this.active = true
  }

  setDiagnosticOperation(id: string | undefined, signal?: AbortSignal) {
    if (id !== this.diagnosticId) this.stderr = new OpenCodeStderr(this.diagnosticSecrets)
    this.diagnosticId = id
    if (signal) this.turnSignal = signal
    this.gateway?.setOperation(id)
  }

  setProgressListener(listener: ((event: string, details: Record<string, unknown>) => void) | undefined) {
    this.progressListener = listener
  }

  stop(reason = 'requested-stop'): void {
    if (this.closed) return
    this.stopReason = reason
    this.closed = true
    this.progressListener = undefined
    this.gateway?.stop()
    clearTimeout(this.idleTimer)
    cleanupAssistantMcpContext(this.key)
    cleanupBrowserMcpContext(this.key)
    if (processes.get(this.key) === this) processes.delete(this.key)
    const pid = this.child?.pid
    if (!pid) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => this.child?.kill())
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        this.child?.kill()
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* Already stopped. */
        }
      }, 1500)
      timer.unref()
    }
  }
}

export async function getOpenCodeProcess(
  key: string,
  directory: string,
  config: unknown,
  roots: string[],
  signal: AbortSignal,
  onStarting?: () => void,
  diagnosticId?: string,
  dailyModel?: string
): Promise<OpenCodeProcess> {
  assertAssistantDataAvailable()
  if (shuttingDown) throw new Error('Zen AI is shutting down')
  if (skillMutation) throw new Error('Skill files are being updated; start the task after the update finishes')
  if (reservations.has(key) || processes.get(key)?.active)
    throw Object.assign(new Error('This new assistant session already has an active task'), {
      name: 'OpenCodeSessionBusyError',
      zenFailureStage: 'runtime-startup',
      zenRuntimeId: 'opencode'
    })
  reservations.add(key)
  try {
    signal.throwIfAborted()
    const configHash = hash(JSON.stringify(config))
    let runtime = processes.get(key)
    if (
      runtime &&
      (runtime.skillsStale ||
        runtime.configHash !== configHash ||
        runtime.directory !== directory ||
        !touchAssistantMcpContext(key) ||
        !touchBrowserMcpContext(key))
    ) {
      runtime.stop()
      runtime = undefined
    }
    if (!runtime) {
      if (processes.size >= 4) {
        const idle = [...processes.values()].find((candidate) => !candidate.active)
        idle?.stop()
        if (processes.size >= 4) throw new Error('Too many concurrent new assistant sessions; stop another task first')
      }
      runtime = new OpenCodeProcess(key, directory, configHash)
      runtime.setDiagnosticOperation(diagnosticId, signal)
      processes.set(key, runtime)
      try {
        onStarting?.()
        await runtime.start(config, roots, signal, dailyModel)
      } catch (error) {
        runtime.stop()
        throw error
      }
    }
    runtime.setDiagnosticOperation(diagnosticId, signal)
    runtime.activate()
    touchAssistantMcpContext(key)
    touchBrowserMcpContext(key)
    return runtime
  } finally {
    reservations.delete(key)
  }
}

export function stopOpenCodeProcesses(): void {
  shuttingDown = true
  for (const runtime of processes.values()) runtime.stop('app-shutdown')
}

export function flushOpenCodeDiagnostic(id: string): void {
  for (const runtime of processes.values()) runtime.flushMatchingDiagnostic(id)
}

/** Never interrupt an active task. Its next user-requested turn gets a fresh inventory. */
export function invalidateOpenCodeSkillInventory(): void {
  for (const runtime of processes.values()) {
    runtime.skillsStale = true
    if (!runtime.active) runtime.stop()
  }
}

export function hasActiveOpenCodeTask(): boolean {
  return reservations.size > 0 || [...processes.values()].some((runtime) => runtime.active)
}

export function hasOpenCodeDataActivity(): boolean {
  return skillMutation || hasActiveOpenCodeTask()
}

/** Called only under the data-operation gate. Stop idle servers, never live tasks. */
export async function quiesceOpenCodeData(): Promise<void> {
  if (hasOpenCodeDataActivity()) throw new Error('Stop active assistant tasks before copying their history')
  await Promise.all([...processes.values()].map((runtime) => runtime.stopAndWait()))
}

/** Read an existing local server only. Never start/prepare a runtime for inspection. */
export async function inspectOpenCodeSkills(key: string) {
  const runtime = processes.get(key)
  if (!runtime) return { status: 'not-running' as const, refreshRequired: false, skills: [] }
  if (!runtime.ready || !runtime.client)
    return { status: 'starting' as const, refreshRequired: runtime.skillsStale, skills: [] }
  try {
    const value = await runtime.client.request<unknown>('/skill', 'GET', undefined, AbortSignal.timeout(3000))
    if (!Array.isArray(value)) throw new Error('Unexpected native inventory')
    return {
      status: 'observed' as const,
      refreshRequired: runtime.skillsStale,
      skills: value
        .slice(0, 1000)
        .flatMap((item) =>
          typeof item?.name === 'string' && typeof item?.location === 'string'
            ? [{ name: item.name.slice(0, 256), path: item.location.slice(0, 4096) }]
            : []
        )
    }
  } catch {
    return { status: 'unavailable' as const, refreshRequired: runtime.skillsStale, skills: [] }
  }
}

export async function withOpenCodeSkillMutation<T>(work: () => Promise<T>): Promise<T> {
  assertAssistantDataAvailable()
  if (skillMutation || hasActiveOpenCodeTask())
    throw new Error('Stop active new-assistant tasks before updating Skill files')
  skillMutation = true
  try {
    return await work()
  } finally {
    skillMutation = false
  }
}

/** Copy durable native history only while both sessions are exclusively reserved. */
export async function copyOpenCodeHistory(sourceKey: string, targetKey: string): Promise<void> {
  assertAssistantDataAvailable()
  if (sourceKey === targetKey) throw new Error('Cannot fork a session into itself')
  for (const key of [sourceKey, targetKey]) {
    if (reservations.has(key) || processes.get(key)?.active)
      throw new Error('Stop the task before changing native history')
  }
  reservations.add(sourceKey)
  reservations.add(targetKey)
  try {
    await processes.get(sourceKey)?.stopAndWait()
    await processes.get(targetKey)?.stopAndWait()
    const source = path.join(getDataPath('OpenCode'), hash(sourceKey))
    const target = path.join(getDataPath('OpenCode'), hash(targetKey))
    // mkdir without recursive fails if the destination already contains history.
    await fs.mkdir(target)
    await fs.cp(path.join(source, 'data'), path.join(target, 'data'), {
      recursive: true,
      errorOnExist: true,
      force: false
    })
    await fs.copyFile(path.join(source, 'binding.json'), path.join(target, 'binding.json'))
  } finally {
    reservations.delete(sourceKey)
    reservations.delete(targetKey)
  }
}

/** Explicit reset/deletion only. Retain a recoverable native-history archive. */
export async function archiveOpenCodeSession(key: string, afterArchive?: () => Promise<void>): Promise<void> {
  assertAssistantDataAvailable()
  if (reservations.has(key) || processes.get(key)?.active)
    throw new Error('Stop the new assistant task before clearing or deleting its session')
  reservations.add(key)
  try {
    const runtime = processes.get(key)
    runtime?.stop()
    const root = path.join(getDataPath('OpenCode'), hash(key))
    const archive = path.join(getDataPath('OpenCode'), `archived-${hash(key)}-${randomUUID()}`)
    let moved = false
    // Both paths are fixed descendants of the app-owned OpenCode data folder.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(root, archive)
        moved = true
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        if (attempt >= 3) throw error
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    // Keep the lease until display-history cleanup completes as well.
    // A new prompt must not start between resetting native and UI history.
    try {
      await afterArchive?.()
    } catch (error) {
      if (moved) {
        await fs.rename(archive, root).catch(() => {
          logger.warn('Native history retained in archive after display reset failed')
        })
      }
      throw error
    }
  } finally {
    reservations.delete(key)
  }
}
