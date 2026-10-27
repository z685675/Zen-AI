import { createPrivateKey, createPublicKey, sign } from 'node:crypto'

import { HOTPATCH_FORMAT, type HotpatchEnvelope } from '../../packages/shared/hotpatch'
import { type HotpatchTrust, signingBytes } from '../../src/main/services/hotpatch/verification'

export function signPayload(
  kind: 'policy' | 'artifact',
  payload: string,
  keyId: string,
  privatePem: string,
  trust: HotpatchTrust
): Buffer {
  if (!Object.hasOwn(trust, keyId)) throw new Error('Signing key ID is not embedded in the base installer')
  const key = createPrivateKey(privatePem),
    expected = createPublicKey(trust[keyId])
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    expected.asymmetricKeyType !== 'ed25519' ||
    !createPublicKey(key)
      .export({ type: 'spki', format: 'der' })
      .equals(expected.export({ type: 'spki', format: 'der' }))
  )
    throw new Error('Signing private key does not match the embedded Ed25519 public root')
  const envelope: HotpatchEnvelope = { format: HOTPATCH_FORMAT, kind, keyId, payload, signature: '' }
  envelope.signature = sign(null, signingBytes(envelope), key).toString('base64url')
  return Buffer.from(JSON.stringify(envelope))
}
