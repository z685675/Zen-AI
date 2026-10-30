import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

// Production carries only the search executable, not the legacy assistant runtime.
export function getRipgrepBinaryPath(): string | null {
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg'
  if (app.isPackaged) {
    const binary = path.join(process.resourcesPath, 'search', name)
    return fs.existsSync(binary) ? binary : null
  }

  const platform = process.platform
  const arch = process.arch
  const target = {
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl'
  }[`${platform}-${arch}`]
  if (!target) return null
  const root = typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd()
  const direct = path.join(
    root,
    'node_modules',
    '@openai',
    `codex-${platform}-${arch}`,
    'vendor',
    target,
    'codex-path',
    name
  )
  if (fs.existsSync(direct)) return direct
  const store = path.join(root, 'node_modules', '.pnpm')
  if (!fs.existsSync(store)) return null
  const suffix = `-${platform}-${arch}`
  for (const entry of fs.readdirSync(store)) {
    if (!entry.startsWith('@openai+codex@') || !entry.endsWith(suffix)) continue
    const binary = path.join(store, entry, 'node_modules', '@openai', 'codex', 'vendor', target, 'codex-path', name)
    if (fs.existsSync(binary)) return binary
  }
  return null
}
