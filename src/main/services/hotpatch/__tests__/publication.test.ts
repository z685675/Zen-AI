import { generateKeyPairSync } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { HOTPATCH_ENTRIES } from '@shared/hotpatch'
import { patchableSource } from '@shared/hotpatchBuild'
import { describe, expect, it } from 'vitest'

import publicVector from '../../../../../scripts/hotpatch/fixtures/public-wire-vector.json'
import { validateRenewal } from '../../../../../scripts/hotpatch/policy-signer'
import { signPayload } from '../../../../../scripts/hotpatch/sign'
import { trustedHotpatchFrame } from '../security'
import { verifyEnvelope } from '../verification'
import { makePolicy, signingFixture } from './fixtures'

describe('protected publication and privileged frame boundaries', () => {
  it('verifies the same whitespace-preserving public wire vector as the API Go verifier', () => {
    const result = verifyEnvelope(Buffer.from(JSON.stringify(publicVector.envelope)), 'policy', {
      [publicVector.envelope.keyId]: publicVector.publicKey
    })
    expect(result.value.policySequence).toBe(7)
    expect(result.value.rollout.salt).toBe('cross-language-vector')
  })
  it('signs exact approved bytes only with the matching embedded public root', () => {
    const pair = generateKeyPairSync('ed25519')
    const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const trust = { review: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
    const payload = Buffer.from(JSON.stringify(makePolicy(), null, 2)).toString('base64url')
    const bytes = signPayload('policy', payload, 'review', pem, trust)
    expect(verifyEnvelope(bytes, 'policy', trust).envelope.payload).toBe(payload)
    expect(() => signPayload('policy', payload, 'unknown', pem, trust)).toThrow('embedded')
    const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(() => signPayload('policy', payload, 'review', other, trust)).toThrow('match')
  })
  it('allows renewal of the same signed scope without widening its release', () => {
    const fixture = signingFixture(),
      original = makePolicy(),
      raw = fixture.encode('policy', original).toString()
    const next = {
      ...original,
      policySequence: 2,
      issuedAt: original.issuedAt + 10,
      expiresAt: original.expiresAt + 1000
    }
    expect(() => validateRenewal(next, raw, 'test-only-ephemeral', fixture.trust)).not.toThrow()
    for (const changed of [
      { ...next, action: 'rollback' as const },
      { ...next, target: { ...next.target!, patchId: 'unreviewed' } },
      { ...next, rollout: { ...next.rollout, basisPoints: 0 } },
      { ...next, base: { ...next.base, version: '9.9.9' } },
      { ...next, policySequence: 1 }
    ])
      expect(() => validateRenewal(changed, raw, 'test-only-ephemeral', fixture.trust)).toThrow('renewal')
  })
  it('keeps state formats, dependencies, workflows, tool code and new native abilities out of patches', () => {
    expect(patchableSource('src/renderer/src/pages/settings/Display.tsx')).toBe(true)
    expect(patchableSource('src/renderer/src/i18n/locales/zh-cn.json')).toBe(true)
    for (const name of [
      'src/main/index.ts',
      'src/preload/index.ts',
      'package.json',
      'pnpm-lock.yaml',
      '.github/workflows/release.yml',
      'src/renderer/src/store/settings.ts',
      'src/renderer/src/components/foo/types.ts',
      'resources/skills/excel/run.py'
    ])
      expect(patchableSource(name), name).toBe(false)
  })
  it('accepts five exact main-frame entries, never external pages, sibling folders or child frames', () => {
    const root = path.resolve('out/renderer'),
      frame = { url: '' },
      sender = { mainFrame: frame, isDestroyed: () => false }
    const event = { sender, senderFrame: frame } as unknown as Electron.IpcMainInvokeEvent
    for (const name of HOTPATCH_ENTRIES) {
      frame.url = pathToFileURL(path.join(root, name)).href + '#/route'
      expect(trustedHotpatchFrame(event, root)).toBe(true)
    }
    frame.url = pathToFileURL(path.join(root, '../other/index.html')).href
    expect(trustedHotpatchFrame(event, root)).toBe(false)
    frame.url = 'https://example.org/index.html'
    expect(trustedHotpatchFrame(event, root)).toBe(false)
    frame.url = pathToFileURL(path.join(root, 'index.html')).href
    expect(trustedHotpatchFrame({ ...event, senderFrame: { ...frame } } as Electron.IpcMainInvokeEvent, root)).toBe(
      false
    )
  })
})
