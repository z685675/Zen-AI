import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const MANIFEST = '.builtin-content.json'
const ignored = (name: string) =>
  ['.version', MANIFEST, '__pycache__', '.DS_Store'].includes(name) || /\.py[co]$/.test(name)

async function inventory(root: string, relative = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (ignored(entry.name)) continue
    const name = path.posix.join(relative, entry.name)
    if (entry.isDirectory()) Object.assign(files, await inventory(root, name))
    else if (entry.isFile())
      files[name] = createHash('sha256')
        .update(await fs.readFile(path.join(root, name)))
        .digest('hex')
    else throw new Error(`Unsupported bundled skill entry: ${name}`)
  }
  return files
}

async function matches(root: string, files: Record<string, string>): Promise<boolean> {
  for (const [name, hash] of Object.entries(files)) {
    try {
      if (
        createHash('sha256')
          .update(await fs.readFile(path.join(root, name)))
          .digest('hex') !== hash
      )
        return false
    } catch {
      return false
    }
  }
  return true
}

/** Refresh bundled content even within one app version, keeping local edits recoverable. */
export async function syncBuiltinSkillFiles(source: string, destination: string, backupRoot: string): Promise<boolean> {
  const files = await inventory(source)
  let previous: Record<string, string> | undefined
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(destination, MANIFEST), 'utf8'))
    if (manifest.version === 1 && manifest.files && typeof manifest.files === 'object') {
      const entries = Object.entries(manifest.files)
      if (
        entries.every(
          ([name, hash]) =>
            name &&
            !path.isAbsolute(name) &&
            !name.includes(':') &&
            !name.includes('\\') &&
            !name.split('/').some((part) => part === '..' || part === '.') &&
            typeof hash === 'string' &&
            /^[a-f0-9]{64}$/.test(hash)
        )
      )
        previous = manifest.files
    }
  } catch {
    // Older installations have only .version. Preserve a copy before their first content update.
  }
  const obsolete = Object.keys(previous ?? {}).filter((name) => !(name in files))
  if (obsolete.length === 0 && (await matches(destination, files))) {
    if (JSON.stringify(previous) !== JSON.stringify(files))
      await fs.writeFile(path.join(destination, MANIFEST), JSON.stringify({ version: 1, files }), 'utf8')
    return false
  }

  let exists = false
  try {
    await fs.access(destination)
    exists = true
  } catch {
    // First install.
  }
  if (exists && (!previous || !(await matches(destination, previous)))) {
    const backup = path.join(backupRoot, path.basename(destination), `${Date.now()}-${randomUUID()}`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.cp(destination, backup, { recursive: true, dereference: false })
  }
  await fs.mkdir(destination, { recursive: true })
  await fs.cp(source, destination, { recursive: true, filter: (file) => !ignored(path.basename(file)) })
  for (const name of obsolete) await fs.rm(path.join(destination, name), { force: true })
  await fs.writeFile(path.join(destination, MANIFEST), JSON.stringify({ version: 1, files }), 'utf8')
  return true
}
