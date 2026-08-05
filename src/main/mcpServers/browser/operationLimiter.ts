export class BrowserOperationQueueTimeoutError extends Error {
  override name = 'BrowserOperationQueueTimeoutError'
}

type QueueEntry = {
  operation: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

/** Keeps Electron BrowserView work bounded when an agent emits parallel tool calls. */
export class BrowserOperationLimiter {
  private active = 0
  private readonly queue: QueueEntry[] = []

  constructor(
    private readonly maxConcurrent = 2,
    private readonly queueTimeoutMs = 5000
  ) {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be at least 1')
    if (queueTimeoutMs < 0) throw new Error('queueTimeoutMs cannot be negative')
  }

  run<T>(operation: () => Promise<T>, label = 'browser operation'): Promise<T> {
    if (this.active < this.maxConcurrent) {
      return this.execute(operation)
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        operation,
        resolve: (value) => resolve(value as T),
        reject
      }

      if (this.queueTimeoutMs > 0) {
        entry.timer = setTimeout(() => {
          const index = this.queue.indexOf(entry)
          if (index === -1) return
          this.queue.splice(index, 1)
          reject(new BrowserOperationQueueTimeoutError(`${label} was waiting for a browser slot too long`))
        }, this.queueTimeoutMs)
      }

      this.queue.push(entry)
    })
  }

  private execute<T>(operation: () => Promise<T>): Promise<T> {
    this.active += 1

    return Promise.resolve()
      .then(operation)
      .finally(() => {
        this.active -= 1
        this.drain()
      })
  }

  private drain() {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift()
      if (!entry) return
      if (entry.timer) clearTimeout(entry.timer)

      this.execute(entry.operation).then(entry.resolve, entry.reject)
    }
  }
}
