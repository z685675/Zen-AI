import { createHash, timingSafeEqual } from 'node:crypto'

// A local preview gate, deliberately scoped to this application launch. Never
// persist an unlocked flag or accept a renderer-supplied authorization flag.
const PASSWORD_HASH = Buffer.from('5493c7714498af69d0721e763495d929deadc3d4d9594e5766eefdc9e0725b10', 'hex')
let unlocked = false

export function isDshPreviewUnlocked(): boolean {
  return unlocked
}

export function unlockDshPreview(password: unknown): boolean {
  if (typeof password !== 'string' || password.length > 128) return false
  const supplied = createHash('sha256').update(password, 'utf8').digest()
  if (!timingSafeEqual(supplied, PASSWORD_HASH)) return false
  unlocked = true
  return true
}

export function lockDshPreview(): void {
  unlocked = false
}

export function assertDshPreviewUnlocked(): void {
  if (!unlocked) {
    throw Object.assign(new Error('Internal testing is locked'), { code: 'internal_testing_locked', status: 403 })
  }
}
