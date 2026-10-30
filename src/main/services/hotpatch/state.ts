import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

import { HOTPATCH_LIMITS, HotpatchError, type HotpatchPolicy } from '@shared/hotpatch'
import * as z from 'zod'

import { sha256 } from './verification'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const reference = z
  .object({ patchId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/), manifestSha256: digest })
  .strict()
export type SnapshotReference = z.infer<typeof reference>
const failure = z.object({ code: z.string().max(80), at: z.number().int().nonnegative() }).strict()
const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    baseBuildId: digest,
    seed: digest,
    highestSequence: z.number().int().nonnegative(),
    policyDigest: digest.nullable(),
    disabledByUser: z.boolean(),
    recoveryRequired: z.boolean(),
    active: reference.nullable(),
    lastGood: reference.nullable(),
    previousGood: reference.nullable(),
    pending: z
      .object({
        target: reference.nullable(),
        policySequence: z.number().int().positive(),
        policyBytes: z.string().max(HOTPATCH_LIMITS.policyBytes * 2)
      })
      .strict()
      .nullable(),
    boot: z
      .object({ target: reference, challenge: digest, policySequence: z.number().int().nonnegative() })
      .strict()
      .nullable(),
    skippedSequence: z.number().int().nonnegative(),
    quarantined: z.array(z.object({ target: reference, code: z.string().max(80) }).strict()).max(100),
    lastError: failure.nullable()
  })
  .strict()
export type HotpatchState = z.infer<typeof stateSchema>

export const sameSnapshot = (left: SnapshotReference | null, right: SnapshotReference | null): boolean =>
  left === null || right === null
    ? left === right
    : left.patchId === right.patchId && left.manifestSha256 === right.manifestSha256

function fresh(baseBuildId: string): HotpatchState {
  return {
    schemaVersion: 1,
    baseBuildId,
    seed: randomBytes(32).toString('hex'),
    highestSequence: 0,
    policyDigest: null,
    disabledByUser: false,
    recoveryRequired: false,
    active: null,
    lastGood: null,
    previousGood: null,
    pending: null,
    boot: null,
    skippedSequence: 0,
    quarantined: [],
    lastError: null
  }
}

/** Independent from Redux/database formats. Writes are serialized and replace a complete fsynced file. */
export class HotpatchStateStore {
  private value: HotpatchState
  private queue: Promise<unknown> = Promise.resolve()
  private constructor(
    readonly root: string,
    initial: HotpatchState
  ) {
    this.value = initial
  }

  static async load(root: string, baseBuildId: string): Promise<HotpatchStateStore> {
    digest.parse(baseBuildId)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const directory = await lstat(root)
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new HotpatchError('storage', 'Invalid patch state directory')
    let initial = fresh(baseBuildId)
    try {
      const file = path.join(root, 'state.json'),
        stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024)
        throw new Error('Invalid state file')
      initial = stateSchema.parse(JSON.parse(await readFile(file, 'utf8')))
      if (initial.baseBuildId !== baseBuildId) throw new Error('Wrong state namespace')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || (await readdir(root)).length > 0) {
        // Keep user conversations/settings intact. Never reset the monotonic sequence and then accept old policies.
        initial.recoveryRequired = true
        initial.lastError = { code: 'state-corrupt', at: Date.now() }
      }
    }
    const store = new HotpatchStateStore(root, initial)
    await store.update(() => {})
    return store
  }

  get snapshot(): HotpatchState {
    return structuredClone(this.value)
  }

  async update<T>(change: (draft: HotpatchState) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const draft = this.snapshot,
        result = change(draft)
      stateSchema.parse(draft)
      const temporary = path.join(this.root, `state-${randomBytes(12).toString('hex')}.tmp`)
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(JSON.stringify(draft))
          await handle.sync()
        } finally {
          await handle.close()
        }
        // rename replaces the old file atomically; never unlink state.json before replacement.
        await rename(temporary, path.join(this.root, 'state.json'))
        this.value = draft
      } finally {
        await unlink(temporary).catch(() => {})
      }
      return result
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  async acceptPolicy(policy: HotpatchPolicy, raw: Uint8Array): Promise<void> {
    const hash = sha256(raw)
    await this.update((state) => {
      if (state.recoveryRequired) throw new HotpatchError('storage', 'Patch state requires safe recovery')
      if (
        policy.policySequence < state.highestSequence ||
        (policy.policySequence === state.highestSequence && state.policyDigest !== hash)
      )
        throw new HotpatchError('policy-replay', 'Policy sequence is stale or reused with different bytes')
      state.highestSequence = policy.policySequence
      state.policyDigest = hash
      // A newer decision cancels an earlier unactivated offer, including pause/gray-cohort changes.
      if (state.pending && state.pending.policySequence !== policy.policySequence) state.pending = null
      if (policy.action === 'pause') state.pending = null
    })
  }

  async stage(policy: HotpatchPolicy, raw: Uint8Array): Promise<void> {
    const target = policy.target && { patchId: policy.target.patchId, manifestSha256: policy.target.manifestSha256 }
    await this.update((state) => {
      if (
        state.recoveryRequired ||
        state.disabledByUser ||
        state.highestSequence !== policy.policySequence ||
        state.policyDigest !== sha256(raw)
      )
        throw new HotpatchError('policy-replay', 'Policy changed while downloading')
      if (policy.action === 'pause' || policy.policySequence <= state.skippedSequence) return
      if (target && state.quarantined.some((item) => sameSnapshot(item.target, target))) return
      if (sameSnapshot(target, state.active)) return
      state.pending = {
        target,
        policySequence: policy.policySequence,
        policyBytes: Buffer.from(raw).toString('base64url')
      }
    })
  }

  /** Select once, before creating any renderer. No network request or running-task refresh here. */
  async beginBoot(
    allowPending: boolean,
    safeMode = false
  ): Promise<{ target: SnapshotReference | null; challenge?: string; trial: boolean }> {
    return this.update((state) => {
      if (state.boot) {
        // An interrupted startup is not proof of malicious/bad code (power loss/user exit).
        // Fall back without permanent quarantine; do not repeatedly trial the same policy.
        state.skippedSequence = Math.max(state.skippedSequence, state.boot.policySequence)
        state.active = state.lastGood
        state.boot = null
        state.pending = null
        state.lastError = { code: 'startup-interrupted', at: Date.now() }
      }
      if (safeMode || state.disabledByUser || state.recoveryRequired) {
        // This process selected builtin. Keep the healthy snapshot for recovery, but let
        // a later explicit offer stage it again after the user resumes updates.
        state.active = null
        return { target: null, trial: false }
      }
      if (state.pending && allowPending) {
        const pending = state.pending
        state.pending = null
        if (!pending.target) {
          state.active = null
          state.lastGood = null
          state.previousGood = null
          return { target: null, trial: false }
        }
        state.active = pending.target
        state.boot = {
          target: pending.target,
          challenge: randomBytes(32).toString('hex'),
          policySequence: pending.policySequence
        }
      } else if (state.active) {
        // Also guard a previously healthy patch's ability to load on the next process start.
        state.boot = { target: state.active, challenge: randomBytes(32).toString('hex'), policySequence: 0 }
      }
      return { target: state.active, challenge: state.boot?.challenge, trial: !!state.boot }
    })
  }

  async healthy(challenge: string): Promise<boolean> {
    return this.update((state) => {
      if (!state.boot || state.boot.challenge !== challenge) return false
      if (!sameSnapshot(state.lastGood, state.boot.target)) state.previousGood = state.lastGood
      state.lastGood = state.boot.target
      state.active = state.boot.target
      state.boot = null
      state.lastError = null
      return true
    })
  }

  async failStartup(code: string): Promise<SnapshotReference | null> {
    return this.update((state) => {
      const target = state.boot?.target ?? state.active
      if (target) {
        state.quarantined = [
          ...state.quarantined.filter((item) => !sameSnapshot(item.target, target)),
          { target, code: code.slice(0, 80) }
        ].slice(-100)
        if (sameSnapshot(state.lastGood, target)) {
          state.lastGood = state.previousGood
          state.previousGood = null
        }
        if (sameSnapshot(state.previousGood, target)) state.previousGood = null
      }
      state.active = state.lastGood
      state.boot = null
      state.pending = null
      state.lastError = { code: code.slice(0, 80), at: Date.now() }
      return state.active
    })
  }

  async disable(): Promise<void> {
    await this.update((state) => {
      state.disabledByUser = true
      state.pending = null
    })
  }

  async enable(): Promise<void> {
    await this.update((state) => {
      if (state.recoveryRequired) throw new HotpatchError('storage', 'Patch state requires safe recovery')
      state.disabledByUser = false
      // Never clear the replay barrier, quarantine, or an interrupted-startup marker.
    })
  }
}
