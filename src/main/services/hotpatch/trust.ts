import type { HotpatchTrust } from './verification'

// Only reviewed, offline-generated public keys belong here. Never a private key or a key from the API.
// Empty until production signing and Windows/macOS installer recovery drills have been approved.
export const HOTPATCH_PRODUCTION_TRUST: HotpatchTrust = Object.freeze({})
export const HOTPATCH_PRODUCTION_ENABLED = false
export const HOTPATCH_POLICY_URL = 'https://zenai.925636.xyz/api/client/patch-policy'
export const HOTPATCH_DOWNLOAD_PREFIX = 'https://download.925636.xyz/zen-ai/hotpatch/'
