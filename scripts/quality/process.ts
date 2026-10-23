import { execFile, spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

export interface Command {
  file: string
  args: string[]
  cwd: string
}

export interface ProcessResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  cancelled: boolean
  durationMs: number
  stdout: string
  stderr: string
  outputTruncated: boolean
  terminationUnconfirmed: boolean
  error?: string
}

// Deliberately not {...process.env}: no API/DB credentials, proxies, dotenv or Node preload hooks.
export function offlineEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed =
    /^(path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|home|userprofile|appdata|localappdata|programfiles|programfiles\(x86\)|programdata|systemdrive|number_of_processors|processor_architecture|lang|lc_all|gopath|gocache|gomodcache|cgo_enabled|cc|cxx|pnpm_home)$/i
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) if (allowed.test(key)) result[key] = value
  return { ...result, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', npm_config_offline: 'true', QUALITY_OFFLINE: '1' }
}

export function redact(text: string) {
  return text
    .replace(/((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]')
    .replace(
      /((?:["']?(?:api[_-]?key|authorization|cookie|set-cookie|password|access[_-]?token|refresh[_-]?token)["']?)\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\r\n]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&#\s"']+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}

export function sanitizeEvidence(value: unknown): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(sanitizeEvidence)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|cookie|set-cookie|password|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(key)
          ? '[REDACTED]'
          : sanitizeEvidence(item)
      ])
    )
  return value
}

class BoundedOutput {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false

  constructor(private readonly limit: number) {}

  append(chunk: Buffer) {
    const available = this.limit - this.size
    if (chunk.length > available) this.truncated = true
    if (available <= 0) return
    const retained = Buffer.from(chunk.subarray(0, available))
    this.chunks.push(retained)
    this.size += retained.length
  }

  text() {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

export async function execute(
  command: Command,
  options: { timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; maxOutputBytes?: number }
): Promise<ProcessResult> {
  const started = performance.now()
  if (options.signal?.aborted) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: true,
      durationMs: 0,
      stdout: '',
      stderr: '',
      outputTruncated: false,
      terminationUnconfirmed: false
    }
  }
  return new Promise((resolve) => {
    const stdout = new BoundedOutput(options.maxOutputBytes ?? 16 * 1024 * 1024)
    const stderr = new BoundedOutput(options.maxOutputBytes ?? 16 * 1024 * 1024)
    let timedOut = false
    let cancelled = false
    let error: string | undefined
    let settled = false
    let stopping = false
    let treeKill: Promise<boolean> | undefined
    let fallback: NodeJS.Timeout | undefined
    const child = spawn(command.file, command.args, {
      cwd: command.cwd,
      env: options.env ?? offlineEnvironment(process.env),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const finish = (exitCode: number | null, signal: string | null, terminationUnconfirmed = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(fallback)
      options.signal?.removeEventListener('abort', cancel)
      resolve({
        exitCode,
        signal,
        timedOut,
        cancelled,
        durationMs: Math.round(performance.now() - started),
        stdout: stdout.text(),
        stderr: stderr.text(),
        outputTruncated: stdout.truncated || stderr.truncated,
        terminationUnconfirmed,
        error
      })
    }
    const stop = () => {
      if (stopping || settled) return
      stopping = true
      // PID is the child just created by this executor. Never build a shell command from a path.
      if (child.pid && child.exitCode === null) {
        if (process.platform === 'win32') {
          treeKill = new Promise((resolveKill) => {
            execFile(
              'taskkill.exe',
              ['/PID', String(child.pid), '/T', '/F'],
              { windowsHide: true, timeout: 8000 },
              (cause) => {
                if (cause && !settled) child.kill('SIGKILL')
                resolveKill(!cause)
              }
            )
          })
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
            treeKill = Promise.resolve(false)
          }
        }
      }
      fallback = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
        finish(child.exitCode, child.signalCode, true)
      }, 10000)
    }
    const cancel = () => {
      cancelled = true
      stop()
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => stdout.append(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk))
    child.on('error', (cause) => {
      error = redact(cause.message)
    })
    child.on('close', async (code, signal) => finish(code, signal, treeKill ? !(await treeKill) : false))
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) cancel()
  })
}
