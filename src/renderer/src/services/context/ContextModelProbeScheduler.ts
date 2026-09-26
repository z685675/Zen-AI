type ScheduledProbe = {
  dueAt: number
  timer: number
}

/** Runs each model recovery probe at its own persisted cooldown deadline. */
export class ContextModelProbeScheduler {
  private readonly timers = new Map<string, ScheduledProbe>()

  schedule(key: string, dueAt: number, callback: () => void): void {
    const existing = this.timers.get(key)
    if (existing?.dueAt === dueAt) return
    this.cancel(key)

    const timer = window.setTimeout(
      () => {
        if (this.timers.get(key)?.timer !== timer) return
        this.timers.delete(key)
        callback()
      },
      Math.max(0, dueAt - Date.now())
    )
    this.timers.set(key, { dueAt, timer })
  }

  cancel(key: string): void {
    const existing = this.timers.get(key)
    if (!existing) return
    window.clearTimeout(existing.timer)
    this.timers.delete(key)
  }

  retain(keys: Set<string>): void {
    for (const key of this.timers.keys()) {
      if (!keys.has(key)) this.cancel(key)
    }
  }

  clear(): void {
    for (const key of this.timers.keys()) this.cancel(key)
  }
}
