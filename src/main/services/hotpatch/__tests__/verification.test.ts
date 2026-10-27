import { HOTPATCH_ENTRIES, HOTPATCH_LIMITS } from '@shared/hotpatch'
import { describe, expect, it } from 'vitest'

import { safeSnapshotPath } from '../resources'
import {
  assertCompatible,
  assertDownloadUrl,
  rolloutEligible,
  sha256,
  validateArtifact,
  validatePolicy,
  verifyEnvelope
} from '../verification'
import { base, makeArtifact, makePolicy, now, signingFixture } from './fixtures'

describe('signed hotpatch boundaries', () => {
  it('verifies exact UTF-8 payload bytes with separate artifact/policy purposes', () => {
    const fixture = signingFixture(),
      artifact = makeArtifact(),
      policy = makePolicy()
    expect(verifyEnvelope(fixture.encode('artifact', artifact), 'artifact', fixture.trust).value).toEqual(artifact)
    expect(verifyEnvelope(fixture.encode('policy', policy), 'policy', fixture.trust).value).toEqual(policy)
    expect(() => verifyEnvelope(fixture.encode('artifact', artifact), 'policy', fixture.trust)).toThrow('purpose')
  })
  it('fails closed for unknown roots, modified bytes, signatures and metadata fields', () => {
    const fixture = signingFixture(),
      bytes = fixture.encode('artifact', makeArtifact())
    expect(() => verifyEnvelope(bytes, 'artifact', {})).toThrow('Untrusted')
    const envelope = JSON.parse(bytes.toString())
    envelope.payload = Buffer.from(JSON.stringify({ ...makeArtifact(), notes: 'changed' })).toString('base64url')
    expect(() => verifyEnvelope(Buffer.from(JSON.stringify(envelope)), 'artifact', fixture.trust)).toThrow('signature')
    expect(() => verifyEnvelope(Buffer.from('not JSON'), 'artifact', fixture.trust)).toThrow('Malformed')
    expect(() =>
      verifyEnvelope(
        fixture.encode('artifact', { ...makeArtifact(), runScript: 'not allowed' }),
        'artifact',
        fixture.trust
      )
    ).toThrow('Malformed')
    expect(() => verifyEnvelope(Buffer.alloc(HOTPATCH_LIMITS.policyBytes + 1), 'policy', fixture.trust)).toThrow(
      'limit'
    )
  })
  it('compares every frozen base identity field, including same version rebuilt with another main/preload', () => {
    expect(() => assertCompatible(base, { ...base })).not.toThrow()
    for (const key of [
      'baseBuildId',
      'mainFingerprint',
      'preloadFingerprint',
      'runtimeFingerprint',
      'contractsFingerprint',
      'securityFingerprint'
    ] as const)
      expect(() => assertCompatible(base, { ...base, [key]: 'f'.repeat(64) })).toThrow('mismatch')
    expect(() => assertCompatible(base, { ...base, arch: 'arm64' })).toThrow('mismatch')
    expect(() => assertCompatible(base, { ...base, packaging: 'portable' })).toThrow('mismatch')
  })
  it('rejects stale/newly implausible clocks, excessive policy lifetimes and ambiguous pause/offer targets', () => {
    const policy = makePolicy()
    expect(() => validatePolicy(policy, base, now)).not.toThrow()
    for (const time of [1, now + 3600, Number.NaN]) expect(() => validatePolicy(policy, base, time)).toThrow('clock')
    expect(() => validatePolicy({ ...policy, issuedAt: now + 301 }, base, now)).toThrow('clock')
    expect(() => validatePolicy({ ...policy, expiresAt: now + 8 * 86400 }, base, now)).toThrow('clock')
    expect(() => validatePolicy({ ...policy, action: 'pause' }, base, now)).toThrow('mismatch')
    expect(() => validatePolicy({ ...policy, target: null }, base, now)).toThrow('mismatch')
    expect(() => validatePolicy({ ...policy, action: 'rollback', target: null }, base, now)).not.toThrow()
  })
  it.each([
    '../x.js',
    '/x.js',
    'C:/x.js',
    'a\\b.js',
    'x.js:payload',
    'a/../b.js',
    'a//b.js',
    'NUL.txt',
    'aux.js',
    'x. /y.js',
    'x%2f.js',
    'x\u0000.js'
  ])('rejects unsafe archive/file paths: %s', (input) => {
    expect(safeSnapshotPath(input)).toBe(false)
  })
  it('requires complete snapshots without executable assets, case collisions, new wasm or size lies', () => {
    const artifact = makeArtifact()
    expect(() => validateArtifact(artifact, base, artifact.files)).not.toThrow()
    for (const extra of ['payload.exe', 'startup.sh', 'unsafe.html', 'index.HTML', 'assets/new.wasm']) {
      const modified = makeArtifact(Object.fromEntries([...HOTPATCH_ENTRIES.map((name) => [name, '']), [extra, '']]))
      expect(() => validateArtifact(modified, base, artifact.files)).toThrow()
    }
    expect(() => validateArtifact({ ...artifact, expandedSize: 1 }, base, artifact.files)).toThrow('size')
    expect(() => validateArtifact({ ...artifact, files: artifact.files.slice(1) }, base, artifact.files)).toThrow()
  })
  it('uses deterministic local cohorts, not model keys or server-side tracking identifiers', () => {
    const policy = makePolicy()
    policy.rollout.basisPoints = 5000
    const values = Array.from({ length: 100 }, (_, index) => rolloutEligible(policy, `local-seed-${index}`))
    expect(values).toEqual(Array.from({ length: 100 }, (_, index) => rolloutEligible(policy, `local-seed-${index}`)))
    expect(values.filter(Boolean).length).toBeGreaterThan(20)
    expect(values.filter(Boolean).length).toBeLessThan(80)
    policy.rollout.basisPoints = 0
    policy.rollout.testCodeHashes = [sha256('private-test-code')]
    expect(rolloutEligible(policy, 'seed')).toBe(false)
    expect(rolloutEligible(policy, 'seed', 'private-test-code')).toBe(true)
  })
  it.each([
    'http://download.925636.xyz/zen-ai/hotpatch/a.zip',
    'https://evil.example/a.zip',
    'https://download.925636.xyz.evil.example/zen-ai/hotpatch/a.zip',
    'https://u:p@download.925636.xyz/zen-ai/hotpatch/a.zip',
    'https://download.925636.xyz/zen-ai/private/a.zip'
  ])('restricts URLs before network access: %s', (url) => {
    expect(() => assertDownloadUrl(url, ['https://download.925636.xyz/zen-ai/hotpatch/'])).toThrow()
  })
})
