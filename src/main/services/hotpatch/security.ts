import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { HOTPATCH_ENTRIES } from '@shared/hotpatch'

// Fixed by the base installer, never by a downloaded snapshot. In particular no remote scripts,
// unsafe-eval, file frames or plugin objects. Providers remain connect-src, never script-src.
export const HOTPATCH_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' https: http: wss: ws: blob:",
  "worker-src 'self' blob:",
  "media-src 'self' blob: data: https: http:",
  'frame-src https: http: blob: data:',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

export function hotpatchWindowPreferences(enabled: boolean): Electron.WebPreferences {
  return enabled
    ? { webSecurity: true, allowRunningInsecureContent: false, contextIsolation: true, nodeIntegration: false }
    : {}
}

export function trustedHotpatchFrame(event: Electron.IpcMainInvokeEvent, rendererRoot: string): boolean {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed()) return false
  const actual = event.senderFrame.url.split(/[?#]/)[0]
  return HOTPATCH_ENTRIES.some((entry) => actual === pathToFileURL(path.join(rendererRoot, entry)).href)
}
