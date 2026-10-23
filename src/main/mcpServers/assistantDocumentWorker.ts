import { Worker } from 'node:worker_threads'

/** One bounded parse, not an agent runtime. Source is application-owned code. */
export function runDocumentWorker<T>(
  source: string,
  data: Record<string, unknown>,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Document read cancelled'))
    const snapshot = data.data
    const transferable =
      Buffer.isBuffer(snapshot) && snapshot.byteOffset === 0 && snapshot.byteLength === snapshot.buffer.byteLength
    const worker = new Worker(source, {
      eval: true,
      workerData: data,
      transferList: transferable ? [snapshot.buffer as ArrayBuffer] : [],
      // V8 heap limit (not an OS RSS limit). File, inflation and result limits
      // separately bound external Buffer allocations owned by our Office reader.
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
    })
    let settled = false
    let stopping = false
    let received = false
    let result: T
    let parseError: Error | undefined
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
      // Cancellation/error/timeout still stops unresponsive code. A successful
      // message must instead wait for normal exit and native/parser cleanup.
      void worker.terminate().then(
        () => finish(error),
        (cause) => finish(new Error(`${label} parser termination failed`, { cause }))
      )
    }
    const cancel = () => {
      stop(new Error('Document read cancelled'))
    }
    const timer = setTimeout(() => {
      stop(new Error(`${label} parser timed out after 15 seconds`))
    }, 15_000)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    worker.once('message', (value) => {
      received = true
      result = value
      if (value?.error) parseError = new Error(`Unable to parse ${label}: ${value.error}`)
    })
    worker.once('error', (error) => {
      stop(error)
    })
    worker.once('exit', (code) => {
      if (stopping) return // The terminate promise owns completion and releases the slot.
      if (code !== 0 || !received)
        finish(new Error(`${label} parser stopped (exit ${code}); document may exceed memory limits`))
      else finish(parseError)
    })
  })
}
