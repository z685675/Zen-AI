import { HOTPATCH_LIMITS, type HotpatchBase, HotpatchError } from '@shared/hotpatch'

import { fetchHotpatch, type HotpatchFetch, readBoundedResponse } from './download'
import { type SnapshotRepository, type VerifiedSnapshot } from './repository'
import { type HotpatchStateStore, sameSnapshot } from './state'
import { type HotpatchTrust, rolloutEligible, sha256, validatePolicy, verifyEnvelope } from './verification'

export class HotpatchEngine {
  private checking?: Promise<boolean>
  constructor(
    private readonly options: {
      base: HotpatchBase
      trust: HotpatchTrust
      policyUrl: string
      allowedPolicy: readonly string[]
      fetcher: HotpatchFetch
      repository: SnapshotRepository
      store: HotpatchStateStore
      now?: () => number
    }
  ) {}
  private get now(): number {
    return Math.floor((this.options.now?.() ?? Date.now()) / 1000)
  }

  /** One batch at a time. An update check never changes this process's selected renderer. */
  check(signal: AbortSignal, testCode?: string): Promise<boolean> {
    if (this.checking) return this.checking
    this.checking = this.checkOnce(signal, testCode).finally(() => {
      this.checking = undefined
    })
    return this.checking
  }

  private async checkOnce(signal: AbortSignal, testCode?: string): Promise<boolean> {
    const { store, fetcher, policyUrl, allowedPolicy, repository, base, trust } = this.options
    if (store.snapshot.disabledByUser || store.snapshot.recoveryRequired) return false
    const response = await fetchHotpatch(fetcher, policyUrl, allowedPolicy, signal)
    if (response.status === 204) return false // Panel not configured: keep local state, not a model/network failure.
    const bytes = await readBoundedResponse(response, HOTPATCH_LIMITS.policyBytes)
    const policy = verifyEnvelope(bytes, 'policy', trust).value
    validatePolicy(policy, base, this.now)
    await store.acceptPolicy(policy, bytes)
    if (
      policy.action === 'pause' ||
      (policy.action === 'offer' && !rolloutEligible(policy, store.snapshot.seed, testCode))
    )
      return false
    if (policy.target) {
      const state = store.snapshot
      if (
        state.quarantined.some((item) => sameSnapshot(item.target, policy.target)) ||
        policy.policySequence <= state.skippedSequence
      )
        return false
      await repository.install(policy.target, signal)
    }
    await store.stage(policy, bytes)
    const latest = store.snapshot
    await repository
      .prune([
        latest.active,
        latest.lastGood,
        latest.previousGood,
        latest.pending?.target ?? null,
        latest.boot?.target ?? null
      ])
      .catch(() => {})
    return store.snapshot.pending !== null
  }

  /** All signature/file/policy checks run again at startup; an offline healthy patch stays usable. */
  async select(safeMode = false): Promise<{ snapshot?: VerifiedSnapshot; challenge?: string }> {
    const { store, repository, trust, base } = this.options
    let allowPending = false
    const pending = store.snapshot.pending
    if (pending && !safeMode) {
      try {
        const raw = Buffer.from(pending.policyBytes, 'base64url')
        const policy = verifyEnvelope(raw, 'policy', trust).value
        validatePolicy(policy, base, this.now)
        allowPending =
          policy.action !== 'pause' &&
          policy.policySequence === pending.policySequence &&
          policy.policySequence === store.snapshot.highestSequence &&
          sha256(raw) === store.snapshot.policyDigest &&
          sameSnapshot(policy.target, pending.target)
      } catch {
        // Expired/newly invalid offers cannot block offline startup with an older healthy version.
      }
      if (!allowPending)
        await store.update((state) => {
          state.pending = null
        })
    }
    let selection = await store.beginBoot(allowPending, safeMode)
    // At most active + older good + builtin. No unbounded recovery loops.
    for (let attempts = 0; selection.target && attempts < 3; attempts++) {
      try {
        return { snapshot: await repository.load(selection.target), challenge: selection.challenge }
      } catch (error) {
        await store.failStartup(error instanceof HotpatchError ? error.code : 'integrity')
        selection = await store.beginBoot(false, safeMode)
      }
    }
    return {}
  }
}
