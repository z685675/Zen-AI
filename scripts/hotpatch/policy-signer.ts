import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { HOTPATCH_LIMITS, type HotpatchPolicy, hotpatchPolicySchema } from '../../packages/shared/hotpatch'
import { readBoundedResponse } from '../../src/main/services/hotpatch/download'
import { HOTPATCH_POLICY_URL, HOTPATCH_PRODUCTION_TRUST } from '../../src/main/services/hotpatch/trust'
import { validatePolicy, verifyEnvelope } from '../../src/main/services/hotpatch/verification'
import { verifyPublishedArtifact } from './artifact'
import { signPayload } from './sign'

interface SigningRequest {
  id: string
  keyId: string
  payload: string
  reason: string
  previousEnvelope?: string
  baseId: string
  sequence: number
}
export function validateRenewal(
  next: HotpatchPolicy,
  previousEnvelope: string,
  keyId: string,
  trust = HOTPATCH_PRODUCTION_TRUST
): void {
  const previous = verifyEnvelope(Buffer.from(previousEnvelope), 'policy', trust)
  const stable = (policy: HotpatchPolicy) => ({ ...policy, issuedAt: 0, expiresAt: 0, policySequence: 0 })
  if (
    previous.envelope.keyId !== keyId ||
    JSON.stringify(stable(previous.value)) !== JSON.stringify(stable(next)) ||
    next.policySequence <= previous.value.policySequence ||
    next.issuedAt < previous.value.issuedAt ||
    next.expiresAt <= previous.value.expiresAt
  )
    throw new Error('Automatic renewal cannot change a signed target, base, action, cohort or key')
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { renew: { type: 'boolean', default: false }, 'intent-id': { type: 'string' } }
  })
  if (values.renew && values['intent-id']) throw new Error('Renewal and manual signing are separate operations')
  if (!values.renew && !/^[a-f0-9]{64}$/.test(values['intent-id'] ?? ''))
    throw new Error('Select a specific reviewed --intent-id for manual signing')
  const token = process.env.ZEN_CLIENT_PATCH_SIGNER_TOKEN,
    pem = process.env.ZEN_HOTPATCH_SIGNING_KEY_PEM
  if (!token || token.length < 32 || !pem) throw new Error('Protected signer credentials are not configured')
  const root = new URL('/api/patch-signer/', HOTPATCH_POLICY_URL)
  const request = async (suffix: string, body?: unknown) => {
    const response = await fetch(new URL(suffix, root), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!response.ok) throw new Error(`Protected signer endpoint returned HTTP ${response.status}`)
    const result = JSON.parse((await readBoundedResponse(response, 16 * 1024 * 1024)).toString())
    if (result.success !== true) throw new Error('Protected signer request was not accepted')
    return result.data
  }
  if (values.renew) await request('renewals', {})
  const queued: SigningRequest[] = await request(values.renew ? 'requests' : `requests?id=${values['intent-id']}`)
  if (!Array.isArray(queued) || queued.length > 50) throw new Error('Invalid signing queue')
  let signedCount = 0
  for (const intent of queued) {
    if (values.renew ? intent.reason !== 'renew-signed-policy' : intent.id !== values['intent-id']) continue
    if (!/^[a-f0-9]{64}$/.test(intent.id) || intent.payload.length > HOTPATCH_LIMITS.policyBytes)
      throw new Error('Invalid signing request')
    const decoded = Buffer.from(intent.payload, 'base64url')
    if (decoded.toString('base64url') !== intent.payload) throw new Error('Non-canonical signing request')
    const policy = hotpatchPolicySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)))
    validatePolicy(policy, policy.base, Math.floor(Date.now() / 1000))
    if (policy.base.baseBuildId !== intent.baseId || policy.policySequence !== intent.sequence)
      throw new Error('Signing scope mismatch')
    if (values.renew) {
      if (!intent.previousEnvelope) throw new Error('Automatic renewal requires its previous signed decision')
      validateRenewal(policy, intent.previousEnvelope, intent.keyId)
    } else if (policy.target) {
      const artifact = await verifyPublishedArtifact(
        policy.target.manifestUrl,
        policy.target.manifestSha256,
        policy.base
      )
      if (artifact.patchId !== policy.target.patchId)
        throw new Error('Published patch target differs from the approved decision')
    }
    const signed = signPayload('policy', intent.payload, intent.keyId, pem, HOTPATCH_PRODUCTION_TRUST)
    const receipt = await request('receipt', { intentId: intent.id, envelope: signed.toString() })
    if (receipt?.status !== 'published') {
      if (!values.renew) throw new Error('Signed decision was superseded; it was not published. Refresh the panel.')
      process.stdout.write(`Skipped superseded renewal ${intent.id}.\n`)
      continue
    }
    signedCount++
    process.stdout.write(`Signed decision ${intent.id} for base ${intent.baseId}, sequence ${intent.sequence}.\n`)
  }
  if (!values.renew && signedCount !== 1)
    throw new Error('Reviewed signing request was not found; refresh the panel and inspect its status')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write(`${String(error)}\n`)
    process.exitCode = 1
  })
