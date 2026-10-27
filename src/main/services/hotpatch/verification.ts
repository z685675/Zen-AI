import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import path from 'node:path'

import {
  HOTPATCH_ENTRIES,
  HOTPATCH_FORMAT,
  HOTPATCH_LIMITS,
  type HotpatchArtifact,
  hotpatchArtifactSchema,
  type HotpatchBase,
  hotpatchBaseSchema,
  type HotpatchEnvelope,
  hotpatchEnvelopeSchema,
  HotpatchError,
  type HotpatchPolicy,
  hotpatchPolicySchema
} from '@shared/hotpatch'

import { safeSnapshotPath } from './resources'

export type HotpatchTrust = Readonly<Record<string, string>>
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export function signingBytes(envelope: Pick<HotpatchEnvelope, 'kind' | 'keyId' | 'payload'>): Buffer {
  return Buffer.from(`${HOTPATCH_FORMAT}\n${envelope.kind}\n${envelope.keyId}\n${envelope.payload}`, 'utf8')
}

function exactBase64url(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw new HotpatchError('schema', 'Non-canonical base64url')
  return bytes
}

export function verifyEnvelope(
  bytes: Uint8Array,
  kind: 'artifact',
  trust: HotpatchTrust
): { envelope: HotpatchEnvelope; value: HotpatchArtifact }
export function verifyEnvelope(
  bytes: Uint8Array,
  kind: 'policy',
  trust: HotpatchTrust
): { envelope: HotpatchEnvelope; value: HotpatchPolicy }
export function verifyEnvelope(bytes: Uint8Array, kind: 'artifact' | 'policy', trust: HotpatchTrust) {
  const maximum = kind === 'policy' ? HOTPATCH_LIMITS.policyBytes : HOTPATCH_LIMITS.manifestBytes
  if (bytes.length > maximum) throw new HotpatchError('size', 'Signed metadata exceeds its byte limit')
  try {
    const envelope = hotpatchEnvelopeSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
    if (envelope.kind !== kind || !Object.hasOwn(trust, envelope.keyId))
      throw new HotpatchError('signature', 'Untrusted key or signature purpose')
    const key = createPublicKey(trust[envelope.keyId])
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      !verify(null, signingBytes(envelope), key, exactBase64url(envelope.signature))
    )
      throw new HotpatchError('signature', 'Invalid artifact/policy signature')
    const payload = exactBase64url(envelope.payload)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payload)
    const value = (kind === 'policy' ? hotpatchPolicySchema : hotpatchArtifactSchema).parse(JSON.parse(text))
    return { envelope, value }
  } catch (error) {
    if (error instanceof HotpatchError) throw error
    throw new HotpatchError('schema', 'Malformed signed metadata')
  }
}

export function assertCompatible(expected: HotpatchBase, actual: HotpatchBase): void {
  const left = hotpatchBaseSchema.parse(expected),
    right = hotpatchBaseSchema.parse(actual)
  for (const key of Object.keys(left) as Array<keyof HotpatchBase>) {
    if (left[key] !== right[key]) throw new HotpatchError('compatibility', `Base build mismatch: ${key}`)
  }
}

export function validatePolicy(policy: HotpatchPolicy, base: HotpatchBase, now: number): void {
  assertCompatible(base, policy.base)
  if (
    !Number.isSafeInteger(now) ||
    now < 1_700_000_000 ||
    policy.issuedAt > now + HOTPATCH_LIMITS.clockSkewSeconds ||
    policy.expiresAt <= now ||
    policy.expiresAt <= policy.issuedAt ||
    policy.expiresAt - policy.issuedAt > HOTPATCH_LIMITS.policyLifetimeSeconds
  )
    throw new HotpatchError('policy-time', 'Expired policy or unreliable local clock')
  if ((policy.action === 'offer' && !policy.target) || (policy.action === 'pause' && policy.target))
    throw new HotpatchError('schema', 'Policy target/action mismatch')
}

const extensions = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.wasm',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.ico',
  '.mp3',
  '.wav',
  '.ogg',
  '.mp4',
  '.webm'
])

export function validateArtifact(
  artifact: HotpatchArtifact,
  base: HotpatchBase,
  builtin: HotpatchArtifact['files']
): void {
  assertCompatible(base, artifact.base)
  const paths = new Set<string>(),
    builtinFiles = new Map(builtin.map((file) => [file.path, file]))
  let total = 0
  for (const file of artifact.files) {
    const extension = path.posix.extname(file.path).toLowerCase()
    if (
      !safeSnapshotPath(file.path) ||
      file.path.normalize('NFC') !== file.path ||
      !extensions.has(extension) ||
      (extension === '.html' && !(HOTPATCH_ENTRIES as readonly string[]).includes(file.path))
    )
      throw new HotpatchError('path', 'Disallowed snapshot resource')
    const folded = file.path.toLowerCase()
    if (paths.has(folded)) throw new HotpatchError('path', 'Duplicate or case-colliding resource')
    // Native/wasm dependency upgrades belong to full installers, not renderer patches.
    if (extension === '.wasm' && builtinFiles.get(file.path)?.sha256 !== file.sha256)
      throw new HotpatchError('compatibility', 'WASM asset is outside the frozen base contract')
    paths.add(folded)
    total += file.size
  }
  if (total !== artifact.expandedSize || total > HOTPATCH_LIMITS.expandedBytes)
    throw new HotpatchError('size', 'Expanded snapshot size mismatch')
  if (HOTPATCH_ENTRIES.some((entry) => !paths.has(entry.toLowerCase())))
    throw new HotpatchError('archive', 'Incomplete multi-window snapshot')
}

export function rolloutEligible(policy: HotpatchPolicy, seed: string, testCode?: string): boolean {
  if (testCode) {
    const digest = Buffer.from(sha256(testCode), 'hex')
    if (policy.rollout.testCodeHashes.some((value) => timingSafeEqual(Buffer.from(value, 'hex'), digest))) return true
  }
  const digest = createHash('sha256').update(`${policy.base.baseBuildId}:${policy.rollout.salt}:${seed}`).digest()
  return digest.readUInt32BE(0) % 10000 < policy.rollout.basisPoints
}

export function assertDownloadUrl(input: string, allowed: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new HotpatchError('url', 'Invalid patch URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    /%(?:2f|5c|2e)/i.test(url.pathname) ||
    !allowed.some((prefix) => {
      const root = new URL(prefix)
      return (
        url.origin === root.origin &&
        (root.pathname.endsWith('/') ? url.pathname.startsWith(root.pathname) : url.pathname === root.pathname)
      )
    })
  )
    throw new HotpatchError('url', 'Patch URL is outside the embedded HTTPS allowlist')
  return url
}
