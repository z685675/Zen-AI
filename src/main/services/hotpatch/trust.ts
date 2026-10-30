import type { HotpatchTrust } from './verification'

// Offline-generated Ed25519 root, validated in the signed online acceptance and rollback drills.
// Only public keys belong here; runtime responses and environment variables cannot add roots.
export const HOTPATCH_PRODUCTION_TRUST: HotpatchTrust = Object.freeze({
  'zen-hotpatch-20261029':
    '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAeqQlhOiB1bifQfcIfqm5Dm+JaUSBSIdyUhBlwbUdW3U=\n-----END PUBLIC KEY-----\n'
})
export const HOTPATCH_PRODUCTION_ENABLED = true
export const HOTPATCH_POLICY_URL = 'https://zenai.925636.xyz/api/client/patch-policy'
export const HOTPATCH_DOWNLOAD_PREFIX = 'https://download.925636.xyz/zen-ai/hotpatch/'
