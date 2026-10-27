import { generateKeyPairSync, sign } from 'node:crypto'

import {
  HOTPATCH_APP_ID,
  HOTPATCH_ENTRIES,
  HOTPATCH_FORMAT,
  type HotpatchArtifact,
  type HotpatchBase,
  type HotpatchPolicy
} from '@shared/hotpatch'

import { sha256, signingBytes } from '../verification'

export const base: HotpatchBase = {
  appId: HOTPATCH_APP_ID,
  version: '1.2.0',
  baseBuildId: '1'.repeat(64),
  baseCommit: '2'.repeat(40),
  platform: 'win32',
  arch: 'x64',
  channel: 'stable',
  packaging: 'installed',
  mainFingerprint: '3'.repeat(64),
  preloadFingerprint: '4'.repeat(64),
  runtimeFingerprint: '5'.repeat(64),
  contractsFingerprint: '6'.repeat(64),
  securityFingerprint: '7'.repeat(64)
}
export const now = 1_800_000_000
export function makeArtifact(
  files: Record<string, string | Buffer> = Object.fromEntries(HOTPATCH_ENTRIES.map((name) => [name, '<!doctype html>']))
): HotpatchArtifact {
  const entries = Object.entries(files).map(([path, data]) => ({
    path,
    size: Buffer.byteLength(data),
    sha256: sha256(typeof data === 'string' ? data : new Uint8Array(data))
  }))
  return {
    schemaVersion: 1,
    patchId: 'patch.1',
    base: { ...base },
    sourceCommit: '8'.repeat(40),
    createdAt: now,
    notes: 'Offline fixture',
    archive: { url: 'https://download.925636.xyz/zen-ai/hotpatch/test.zip', sha256: '9'.repeat(64), size: 100 },
    expandedSize: entries.reduce((total, file) => total + file.size, 0),
    files: entries
  }
}
export function makePolicy(): HotpatchPolicy {
  return {
    schemaVersion: 1,
    base: { ...base },
    policySequence: 1,
    issuedAt: now - 60,
    expiresAt: now + 3600,
    action: 'offer',
    target: {
      patchId: 'patch.1',
      manifestUrl: 'https://download.925636.xyz/zen-ai/hotpatch/test.json',
      manifestSha256: 'a'.repeat(64)
    },
    rollout: { basisPoints: 10000, salt: 'stable-cohort-1', testCodeHashes: [] }
  }
}
export function signingFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const keyId = 'test-only-ephemeral'
  const trust = { [keyId]: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  return {
    trust,
    encode(kind: 'artifact' | 'policy', value: unknown): Buffer {
      const envelope = {
        format: HOTPATCH_FORMAT,
        kind,
        keyId,
        payload: Buffer.from(JSON.stringify(value)).toString('base64url'),
        signature: ''
      }
      envelope.signature = sign(null, signingBytes(envelope), privateKey).toString('base64url')
      return Buffer.from(JSON.stringify(envelope))
    }
  }
}
