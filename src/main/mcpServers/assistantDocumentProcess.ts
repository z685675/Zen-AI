import { spawn } from 'node:child_process'

/** Native PDF dependencies must not share Electron's address space. */
export function runDocumentProcess<T>(
  source: string,
  data: Record<string, unknown>,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error('Document read cancelled'))
  // No API credentials, proxies, Node preloads or user scripts in the parser.
  // This is the application's own executable; users do not need system Node.
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|pathext|systemroot|windir|temp|tmp|tmpdir|home|userprofile|lang|lc_all)$/i.test(key)) env[key] = value
  }
  // Only application-owned source goes on the command line. Document bytes and
  // paths travel over IPC, not through shell interpolation, base64 or temp files.
  const bootstrap = `
    let completed = false
    process.once('disconnect', () => { if (!completed) process.exit(1) })
    process.once('message', async workerData => {
      let message
      try {
        message = { result: await (async () => { ${source} })() }
      } catch (error) {
        message = { error: String(error.message || error).slice(0, 1000) }
      }
      process.send(message, error => {
        if (error) process.exitCode = 1
        completed = true
        if (process.connected) process.disconnect()
      })
    })
  `
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=192', '--max-semi-space-size=16', '--eval', bootstrap],
      { env, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' }
    )
    let settled = false
    let stopping = false
    let received = false
    let result: T
    let failure: Error | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve(result!)
    }
    const stop = (error: Error) => {
      if (settled || stopping) return
      stopping = true
      failure = error
      // This parser never spawns external commands. Reap the process before
      // releasing its concurrency slot, including after a result was posted.
      child.kill('SIGKILL')
    }
    const cancel = () => stop(new Error('Document read cancelled'))
    const timer = setTimeout(() => stop(new Error(`${label} parser timed out after 15 seconds`)), 15_000)
    signal?.addEventListener('abort', cancel, { once: true })
    child.once('message', (value: { result?: T; error?: string }) => {
      received = true
      if (typeof value?.error === 'string') failure = new Error(`Unable to parse ${label}: ${value.error}`)
      else if (value && Object.hasOwn(value, 'result')) result = value.result!
      else failure = new Error(`${label} parser returned an invalid result`)
    })
    child.once('error', (error) => stop(error))
    child.once('close', (code, exitSignal) => {
      if (failure) finish(failure)
      else if (code !== 0 || !received)
        finish(new Error(`${label} parser stopped (exit ${code}, signal ${exitSignal ?? 'none'})`))
      else finish()
    })
    if (signal?.aborted) cancel()
    if (!stopping) {
      try {
        child.send(data, (error) => error && stop(error))
      } catch (error) {
        stop(error as Error)
      }
    }
  })
}
