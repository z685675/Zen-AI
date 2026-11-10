import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { loggerService } from '@logger'

import { assertDshPreviewUnlocked } from './access'
import {
  buildDshEnvironment,
  cancelDshPreviewPreparation,
  dshDataRoot,
  getDshPreviewRuntimeStatus,
  getPreparedDshRuntime,
  prepareDshPreviewRuntime as prepareInstallation
} from './install'

export { getDshPreviewRuntimeStatus }
const logger = loggerService.withContext('DshRuntime')

export type DshEvent = { method: string; params: Record<string, any>; id?: number | string }
export type DshNativeEvent = { type: string; seq: number; time?: number; data: Record<string, any> }
export type DshHistory = { sessionId: string; header?: Record<string, any>; events: DshNativeEvent[] }
export type DshRuntimeConfig = {
  sessionId: string
  cwd: string
  provider: {
    api: string
    baseURL: string
    model: string
    apiKey?: string
    headers?: Record<string, string>
    contextWindow?: number
    maxTokens?: number
    compat?: Record<string, unknown>
  }
  additionalRoots?: string[]
  skillRoots?: string[]
  mcp?: Record<string, unknown>[]
  readOnly?: boolean
  instructions?: string
  effort?: string
  approveToolPrefixes?: string[]
}

type SessionMapping = { nativeId: string; generation: string; initialized?: boolean; seed?: DshNativeEvent[] }
const runtimes = new Map<string, Promise<DshRuntime>>()
const signatures = new Map<string, string>()

export function prepareDshPreviewRuntime(signal?: AbortSignal) {
  assertDshPreviewUnlocked()
  return prepareInstallation(signal)
}

function sessionDirectory(sessionId: string) {
  if (!sessionId || sessionId.length > 512) throw new Error('Invalid DSH session identity')
  return path.join(dshDataRoot(), 'sessions', createHash('sha256').update(sessionId).digest('hex'))
}

async function mappingOf(sessionId: string): Promise<SessionMapping> {
  const directory = sessionDirectory(sessionId)
  await fs.mkdir(directory, { recursive: true })
  try {
    const mapping = JSON.parse(await fs.readFile(path.join(directory, 'native.json'), 'utf8')) as SessionMapping
    if (!/^generation-[a-zA-Z0-9-]+$/.test(mapping.generation) || !/^zen-[a-zA-Z0-9_-]+$/.test(mapping.nativeId))
      throw new Error('Invalid DSH native session mapping')
    return mapping
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const mapping = {
      nativeId: `zen-${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`,
      generation: `generation-${randomUUID()}`
    }
    await fs.writeFile(path.join(directory, 'native.json'), JSON.stringify(mapping))
    return mapping
  }
}

async function writeJsonAtomically(target: string, value: unknown) {
  const temporary = `${target}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value))
  await fs.rename(temporary, target)
}

export async function getDshRuntime(config: DshRuntimeConfig, signal: AbortSignal): Promise<DshRuntime> {
  assertDshPreviewUnlocked()
  signal.throwIfAborted()
  const signature = createHash('sha256').update(JSON.stringify(config)).digest('hex')
  let current = runtimes.get(config.sessionId)
  if (current && signatures.get(config.sessionId) !== signature) {
    await (await current).stop()
    current = undefined
  }
  if (!current) {
    signatures.set(config.sessionId, signature)
    current = DshRuntime.create(config, signal)
    runtimes.set(config.sessionId, current)
    current.catch(() => {
      if (runtimes.get(config.sessionId) === current) runtimes.delete(config.sessionId)
    })
  }
  const runtime = await current
  if (signal.aborted) {
    await stopDshSession(config.sessionId, runtime)
    signal.throwIfAborted()
  }
  return runtime
}

export class DshRuntime extends EventEmitter {
  private counter = 0
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
  >()
  private exited = false
  private stopping?: Promise<void>
  private closed: Promise<void>
  private history: DshHistory
  readonly nativeId: string

  private constructor(
    readonly zenSessionId: string,
    private child: ChildProcessWithoutNullStreams,
    nativeId: string,
    private home: string
  ) {
    super()
    this.nativeId = nativeId
    this.history = { sessionId: nativeId, events: [] }
    this.closed = new Promise((resolve) => child.once('close', () => resolve()))
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      if (line.length > 64 * 1024 * 1024) {
        void this.stop()
        return
      }
      let frame: DshEvent & { result?: unknown; error?: { message?: string } }
      try {
        frame = JSON.parse(line)
      } catch {
        return
      }
      if (frame.method) {
        if (frame.method === 'session.event' && frame.params.sessionId === this.nativeId) {
          const event = frame.params.event as DshNativeEvent
          if (Number.isSafeInteger(event.seq) && event.seq >= 0) this.history.events[event.seq] = event
        }
        this.emit('event', frame)
      } else if (typeof frame.id === 'number') {
        const request = this.pending.get(frame.id)
        if (!request) return
        this.pending.delete(frame.id)
        clearTimeout(request.timeout)
        if (frame.error) request.reject(new Error(frame.error.message || 'DSH bridge request failed'))
        else request.resolve(frame.result)
      }
    })
    // DSH/native tools may include credentials or file contents in stderr.
    // Consume it without retaining it or forwarding it to renderer diagnostics.
    child.stderr.resume()
    child.once('error', () => this.fail(new Error('DSH runtime could not start')))
    child.once('close', (code) => {
      this.exited = true
      lines.close()
      this.fail(new Error(`DSH runtime exited (${code ?? 'signal'})`))
      if (!this.stopping) this.emit('runtime-error', new Error('DSH runtime stopped unexpectedly'))
      logger.info('DSH runtime stopped', { code, sessionId: zenSessionId })
      const owned = runtimes.get(zenSessionId)
      void owned?.then(
        (runtime) => {
          if (runtime === this && runtimes.get(zenSessionId) === owned) runtimes.delete(zenSessionId)
        },
        () => undefined
      )
    })
  }

  static async create(config: DshRuntimeConfig, signal: AbortSignal) {
    const prepared = getPreparedDshRuntime()
    signal.throwIfAborted()
    assertDshPreviewUnlocked()
    const mapping = await mappingOf(config.sessionId)
    const home = path.join(sessionDirectory(config.sessionId), mapping.generation)
    await fs.mkdir(home, { recursive: true })
    const child = spawn(prepared.execPath, [prepared.entryPath, prepared.runtimeRoot], {
      cwd: config.cwd,
      env: buildDshEnvironment(home),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const runtime = new DshRuntime(config.sessionId, child, mapping.nativeId, home)
    const cancel = () => {
      void runtime.stop()
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      await runtime.call(
        'initialize',
        { ...config, sessionId: mapping.nativeId, resume: Boolean(mapping.initialized), seed: mapping.seed },
        120_000
      )
      signal.throwIfAborted()
      mapping.initialized = true
      delete mapping.seed
      await writeJsonAtomically(path.join(sessionDirectory(config.sessionId), 'native.json'), mapping)
      runtime.history = await runtime.call('session/history')
      await runtime.persistHistory()
      return runtime
    } catch (error) {
      await runtime.stop()
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    if (this.exited || this.child.stdin.destroyed) return Promise.reject(new Error('DSH runtime is not running'))
    const id = ++this.counter
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`DSH runtime request timed out: ${method}`))
        if (method !== 'shutdown') void this.stop()
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (!error) return
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(new Error('DSH runtime input pipe closed'))
      })
    })
  }

  answer(id: string | number, result: Record<string, unknown>) {
    if (!this.exited && !this.child.stdin.destroyed)
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  async wait() {
    await this.call('session/wait', {}, 31 * 60_000)
    this.history = await this.call('session/history')
    await this.persistHistory()
  }

  async persistHistory() {
    await writeJsonAtomically(path.join(this.home, 'history.json'), this.history)
  }

  snapshot(): DshHistory {
    return structuredClone(this.history)
  }

  stop(): Promise<void> {
    return (this.stopping ??= this.stopProcess())
  }

  private async stopProcess() {
    if (this.exited) return
    await this.call('shutdown', {}, 5000).catch(() => undefined)
    if (!this.exited) {
      if (process.platform === 'win32' && this.child.pid) {
        const killer = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        await once(killer, 'close').catch(() => undefined)
      } else if (this.child.pid) {
        try {
          process.kill(-this.child.pid, 'SIGTERM')
        } catch {
          this.child.kill()
        }
      }
      await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, 1500))])
      if (!this.exited && this.child.pid) {
        try {
          process.kill(process.platform === 'win32' ? this.child.pid : -this.child.pid, 'SIGKILL')
        } catch {
          this.child.kill('SIGKILL')
        }
        // Releasing a session lease before the actual child close could admit a
        // second writer to this native history. Forced stop must finish first.
        await this.closed
      }
    }
    await this.persistHistory().catch(() => undefined)
  }

  private fail(error: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    this.pending.clear()
  }
}

export async function stopDshSession(sessionId: string, expected?: DshRuntime) {
  const pending = runtimes.get(sessionId)
  if (expected) {
    const current = await pending?.catch(() => undefined)
    await expected.stop()
    if (current !== expected || runtimes.get(sessionId) !== pending) return
  }
  if (pending)
    await pending.then(
      (runtime) => runtime.stop(),
      () => undefined
    )
  if (runtimes.get(sessionId) === pending) {
    runtimes.delete(sessionId)
    signatures.delete(sessionId)
  }
}

export async function stopAllDshRuntimes() {
  await cancelDshPreviewPreparation()
  await Promise.allSettled([...runtimes.keys()].map((sessionId) => stopDshSession(sessionId)))
}

export async function steerDshSession(sessionId: string, text: string) {
  assertDshPreviewUnlocked()
  const runtime = await runtimes.get(sessionId)
  if (!runtime) throw new Error('DSH session is not running')
  return runtime.call('session/steer', { text, messageId: `zen-input-${randomUUID().replaceAll('-', '')}` })
}

export async function readDshSessionHistory(sessionId: string): Promise<DshHistory> {
  assertDshPreviewUnlocked()
  const runtime = await runtimes.get(sessionId)
  if (runtime) return runtime.snapshot()
  try {
    const mapping = await mappingOf(sessionId)
    return JSON.parse(
      await fs.readFile(path.join(sessionDirectory(sessionId), mapping.generation, 'history.json'), 'utf8')
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { sessionId: (await mappingOf(sessionId)).nativeId, events: [] }
  }
}

async function replaceDshHistory(sessionId: string, seed: DshNativeEvent[], attachmentSourceSessionId = sessionId) {
  await stopDshSession(sessionId)
  const source = await mappingOf(attachmentSourceSessionId)
  const mapping: SessionMapping = {
    nativeId: `zen-${randomUUID()}`,
    generation: `generation-${randomUUID()}`,
    ...(seed.length ? { seed } : {})
  }
  const home = path.join(sessionDirectory(sessionId), mapping.generation)
  await fs.mkdir(home, { recursive: true })
  // Keep the immutable attachment store even for an empty seed: the caller may
  // need to restore the previous events if its database transaction fails.
  const attachments = path.join(sessionDirectory(attachmentSourceSessionId), source.generation, 'attachments')
  if ((await fs.stat(attachments).catch(() => undefined))?.isDirectory())
    await fs.cp(attachments, path.join(home, 'attachments'), { recursive: true, dereference: false })
  await writeJsonAtomically(path.join(home, 'history.json'), { sessionId: mapping.nativeId, events: seed })
  // Publish the generation only after its seed and immutable attachments exist.
  await writeJsonAtomically(path.join(sessionDirectory(sessionId), 'native.json'), mapping)
  return { sessionId: mapping.nativeId, events: seed }
}

export async function replaceDshSessionHistory(sessionId: string, events: DshNativeEvent[]): Promise<DshHistory> {
  assertDshPreviewUnlocked()
  let open = false
  for (let seq = 0; seq < events.length; seq++) {
    const event = events[seq]
    if (!event || event.seq !== seq) throw new Error('DSH history must be a continuous native prefix')
    if (event.type === 'turn/start') open = true
    if (event.type === 'turn/end') open = false
  }
  if (open) throw new Error('DSH history must end at a closed turn boundary')
  await mappingOf(sessionId)
  return replaceDshHistory(sessionId, structuredClone(events))
}

export async function resetDshSession(sessionId: string) {
  assertDshPreviewUnlocked()
  await mappingOf(sessionId)
  return replaceDshHistory(sessionId, [])
}

export async function rewindDshSession(sessionId: string, beforeUserMessageId?: string) {
  assertDshPreviewUnlocked()
  const history = await readDshSessionHistory(sessionId)
  let target = -1
  for (let index = 0; index < history.events.length; index++) {
    const event = history.events[index]
    if (
      event.type === 'user/message' &&
      event.data.source?.kind === 'user' &&
      (!beforeUserMessageId || event.data.id === beforeUserMessageId)
    )
      target = index
  }
  if (target < 0) throw new Error('DSH history does not contain the requested user message')
  while (target >= 0 && history.events[target].type !== 'turn/start') target--
  if (target < 0) throw new Error('DSH history does not contain a safe retry boundary')
  // Seed only a closed prefix; creating/resuming a seed never replays tools.
  return replaceDshHistory(sessionId, history.events.slice(0, target))
}

export async function forkDshSession(sourceSessionId: string, targetSessionId: string) {
  assertDshPreviewUnlocked()
  const history = await readDshSessionHistory(sourceSessionId)
  let open = false
  for (const event of history.events) {
    if (event.type === 'turn/start') open = true
    if (event.type === 'turn/end') open = false
  }
  if (open) throw new Error('Wait for the DSH turn to finish before forking')
  await mappingOf(targetSessionId)
  return replaceDshHistory(targetSessionId, history.events, sourceSessionId)
}

export async function deleteDshSession(sessionId: string) {
  assertDshPreviewUnlocked()
  await stopDshSession(sessionId)
  await fs.rm(sessionDirectory(sessionId), { recursive: true, force: true })
}
