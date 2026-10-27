import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { HotpatchStateStore } from '../state'
import { base, makePolicy, signingFixture } from './fixtures'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
const roots: string[] = []
async function store() {
  const root = await mkdtemp(path.join(tmpdir(), 'zen-hotpatch-state-'))
  roots.push(root)
  return HotpatchStateStore.load(root, base.baseBuildId)
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('atomic patch selection and startup recovery', () => {
  it('stages only the accepted decision, activates at next boot, accepts a matching health challenge', async () => {
    const state = await store(),
      policy = makePolicy(),
      raw = signingFixture().encode('policy', policy)
    await state.acceptPolicy(policy, raw)
    await state.stage(policy, raw)
    expect(state.snapshot.active).toBeNull()
    const boot = await state.beginBoot(true)
    expect(boot.target?.patchId).toBe('patch.1')
    expect(boot.trial).toBe(true)
    expect(await state.healthy('wrong')).toBe(false)
    expect(await state.healthy(boot.challenge!)).toBe(true)
    expect(state.snapshot.lastGood).toEqual(boot.target)
    const reopened = await HotpatchStateStore.load(state.root, base.baseBuildId)
    expect(reopened.snapshot).toEqual(state.snapshot)
    expect(JSON.parse(await readFile(path.join(state.root, 'state.json'), 'utf8')).seed).toHaveLength(64)
  })
  it('rejects policy replay/equivocation and late download completion after pause', async () => {
    const state = await store(),
      policy = makePolicy(),
      raw = signingFixture().encode('policy', policy)
    await state.acceptPolicy(policy, raw)
    await state.acceptPolicy(policy, raw)
    await expect(state.acceptPolicy(policy, Buffer.from('different'))).rejects.toThrow('sequence')
    const pause = { ...policy, policySequence: 2, action: 'pause' as const, target: null }
    await state.acceptPolicy(pause, Buffer.from('pause'))
    await expect(state.acceptPolicy(policy, raw)).rejects.toThrow('sequence')
    await expect(state.stage(policy, raw)).rejects.toThrow('changed')
    expect(state.snapshot.pending).toBeNull()
  })
  it('falls back from a bad new trial to the previous healthy version, quarantines only that snapshot', async () => {
    const state = await store(),
      policy = makePolicy(),
      fixture = signingFixture()
    let raw = fixture.encode('policy', policy)
    await state.acceptPolicy(policy, raw)
    await state.stage(policy, raw)
    await state.healthy((await state.beginBoot(true)).challenge!)
    const next = {
      ...policy,
      policySequence: 2,
      target: { ...policy.target!, patchId: 'patch.2', manifestSha256: 'b'.repeat(64) }
    }
    raw = fixture.encode('policy', next)
    await state.acceptPolicy(next, raw)
    await state.stage(next, raw)
    await state.beginBoot(true)
    expect((await state.failStartup('renderer-crashed'))?.patchId).toBe('patch.1')
    expect(state.snapshot.quarantined.map((item) => item.target.patchId)).toEqual(['patch.2'])
    await state.stage(next, raw)
    expect(state.snapshot.pending).toBeNull()
  })
  it('retains an older good snapshot even after the next one was once healthy', async () => {
    const state = await store(),
      fixture = signingFixture()
    for (let sequence = 1; sequence <= 2; sequence++) {
      const policy = makePolicy()
      policy.policySequence = sequence
      policy.target!.patchId = `patch.${sequence}`
      const raw = fixture.encode('policy', policy)
      await state.acceptPolicy(policy, raw)
      await state.stage(policy, raw)
      await state.healthy((await state.beginBoot(true)).challenge!)
    }
    await state.beginBoot(false)
    expect((await state.failStartup('missing-chunk'))?.patchId).toBe('patch.1')
  })
  it('does not call a user-interrupted trial permanently bad or retry it in a loop', async () => {
    const state = await store(),
      policy = makePolicy(),
      raw = signingFixture().encode('policy', policy)
    await state.acceptPolicy(policy, raw)
    await state.stage(policy, raw)
    await state.beginBoot(true)
    const reopened = await HotpatchStateStore.load(state.root, base.baseBuildId)
    expect((await reopened.beginBoot(true)).target).toBeNull()
    expect(reopened.snapshot.quarantined).toEqual([])
    await reopened.stage(policy, raw)
    expect(reopened.snapshot.pending).toBeNull()
  })
  it('supports higher-sequence rollback to builtin without accepting an old sequence', async () => {
    const state = await store(),
      policy = makePolicy(),
      fixture = signingFixture()
    let raw = fixture.encode('policy', policy)
    await state.acceptPolicy(policy, raw)
    await state.stage(policy, raw)
    await state.healthy((await state.beginBoot(true)).challenge!)
    const rollback = { ...policy, policySequence: 2, action: 'rollback' as const, target: null }
    raw = fixture.encode('policy', rollback)
    await state.acceptPolicy(rollback, raw)
    await state.stage(rollback, raw)
    expect(state.snapshot.active?.patchId).toBe('patch.1')
    expect((await state.beginBoot(true)).target).toBeNull()
    expect(state.snapshot.highestSequence).toBe(2)
  })
  it('preserves the monotonic barrier across serialized writes and fails closed on corrupt/missing existing state', async () => {
    const state = await store()
    await Promise.all(
      Array.from({ length: 30 }, () =>
        state.update((draft) => {
          draft.highestSequence++
        })
      )
    )
    expect(state.snapshot.highestSequence).toBe(30)
    await writeFile(path.join(state.root, 'state.json'), '{broken')
    const corrupt = await HotpatchStateStore.load(state.root, base.baseBuildId)
    expect(corrupt.snapshot.recoveryRequired).toBe(true)
    await expect(corrupt.enable()).rejects.toThrow('recovery')
    await expect(corrupt.acceptPolicy(makePolicy(), Buffer.from('x'))).rejects.toThrow('recovery')
    await rm(path.join(state.root, 'state.json'))
    await mkdir(path.join(state.root, 'snapshots'))
    expect((await HotpatchStateStore.load(state.root, base.baseBuildId)).snapshot.recoveryRequired).toBe(true)
  })
  it('safe mode and user opt-out keep builtin, without deleting downloaded/user data', async () => {
    const state = await store(),
      policy = makePolicy(),
      raw = signingFixture().encode('policy', policy)
    await state.acceptPolicy(policy, raw)
    await state.stage(policy, raw)
    expect((await state.beginBoot(true, true)).target).toBeNull()
    expect(state.snapshot.pending).not.toBeNull()
    await state.disable()
    expect((await state.beginBoot(true)).target).toBeNull()
    expect(state.snapshot.disabledByUser).toBe(true)
    await state.enable()
    expect(state.snapshot.disabledByUser).toBe(false)
    expect(state.snapshot.highestSequence).toBe(1)
  })
})
