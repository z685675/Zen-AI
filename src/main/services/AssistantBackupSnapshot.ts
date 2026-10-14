import path from 'node:path'

import { createClient } from '@libsql/client'
import * as fs from 'fs-extra'

const nativeFolder = /^[a-f0-9]{64}$/
const agentDatabase = /^agents\.db(?:-(?:wal|shm|journal))?$/

export function includeAssistantBackupPath(relative: string, slim: boolean): boolean {
  const parts = relative.split(/[\\/]/).filter(Boolean)
  if (!parts.length) return true
  if (parts.length === 1 && agentDatabase.test(parts[0])) return false // SQLite snapshot below, never hot-copy WAL.
  if (!slim) return true
  if (parts[0] === 'Skills') return true
  if (parts[0] !== 'OpenCode') return false
  if (parts.length === 1) return true
  if (!nativeFolder.test(parts[1])) return false
  return parts.length === 2 || parts[2] === 'data' || (parts.length === 3 && parts[2] === 'binding.json')
}

/** Caller holds admission gate and has stopped idle native servers. No model requests. */
export async function copyAssistantBackupData(source: string, destination: string, slim: boolean): Promise<void> {
  await fs.ensureDir(destination)
  if (!(await fs.pathExists(source))) return
  await fs.copy(source, destination, {
    dereference: false,
    filter: async (file) =>
      includeAssistantBackupPath(path.relative(source, file), slim) && !(await fs.lstat(file)).isSymbolicLink()
  })
  const database = path.join(source, 'agents.db')
  if (!(await fs.pathExists(database))) return
  const client = createClient({ url: `file:${database}` })
  try {
    await client.execute({ sql: 'VACUUM main INTO ?', args: [path.join(destination, 'agents.db')] })
  } finally {
    client.close()
  }
}

/** Slim restores overlay logical history; omitted attachments are NOT instructions to delete them. */
export async function stageAssistantBackupData(
  source: string,
  current: string,
  staging: string,
  slim: boolean
): Promise<void> {
  await fs.remove(staging)
  if (slim && (await fs.pathExists(current))) await fs.copy(current, staging, { dereference: false })
  await fs.ensureDir(staging)
  if (slim) {
    for (const suffix of ['-wal', '-shm', '-journal']) await fs.remove(path.join(staging, `agents.db${suffix}`))
    const nativeRoot = path.join(source, 'OpenCode')
    const folders = await fs.readdir(nativeRoot).catch(() => [])
    for (const folder of folders) if (nativeFolder.test(folder)) await fs.remove(path.join(staging, 'OpenCode', folder))
  }
  await fs.copy(source, staging, { overwrite: true, dereference: false })
}
