import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const locks = new Map<string, Promise<unknown>>()
const MAX_BACKUP_BYTES = 128 * 1024 * 1024

function inside(file: string, root: string) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** Resolve every existing ancestor before creating directories or backup files. */
export async function assertSafeOutput(file: string, roots: string[]) {
  const resolved = path.resolve(file)
  if (!roots.some((root) => inside(resolved, path.resolve(root))))
    throw new Error('Output is outside authorized folders')
  const canonicalRoots = await Promise.all(roots.map((root) => fs.realpath(root).catch(() => path.resolve(root))))
  let ancestor = resolved
  while (true) {
    const stat = await fs.lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    if (stat) {
      if (ancestor === resolved && stat.isSymbolicLink()) throw new Error('Refusing to replace a symbolic link')
      const canonical = await fs.realpath(ancestor)
      if (!canonicalRoots.some((root) => inside(canonical, root)))
        throw new Error('Output resolves outside authorized folders')
      return resolved
    }
    const parent = path.dirname(ancestor)
    if (parent === ancestor) throw new Error('No authorized output ancestor exists')
    ancestor = parent
  }
}

async function exclusive<T>(file: string, work: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
  const previous = locks.get(key)
  const current = (previous ?? Promise.resolve()).catch(() => undefined).then(work)
  locks.set(key, current)
  try {
    return await current
  } finally {
    if (locks.get(key) === current) locks.delete(key)
  }
}

async function existingFile(file: string) {
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (stat && !stat.isFile()) throw new Error('Target must be a regular file, not a folder or symbolic link')
  return stat
}

function unchanged(a: Awaited<ReturnType<typeof fs.stat>>, b: Awaited<ReturnType<typeof fs.stat>>) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

async function backup(file: string, roots: string[], signal?: AbortSignal) {
  signal?.throwIfAborted()
  await assertSafeOutput(file, roots)
  const before = await existingFile(file)
  if (!before) throw new Error('Cannot back up a missing file')
  if (before.size > MAX_BACKUP_BYTES)
    throw new Error('File exceeds 128 MiB backup limit; save the result as a new file instead')
  const dir = path.join(path.dirname(file), '.zen-backups')
  await assertSafeOutput(path.join(dir, 'placeholder'), roots)
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, `${path.parse(file).name}-${Date.now()}-${randomUUID()}${path.extname(file)}`)
  signal?.throwIfAborted()
  await fs.copyFile(file, target, fs.constants.COPYFILE_EXCL)
  if (!unchanged(before, await fs.lstat(file)))
    throw new Error(`File changed during backup; original was not overwritten. Backup: ${target}`)
  return { path: target, before }
}

export function backupAssistantFile(file: string, roots: string[], signal?: AbortSignal) {
  return exclusive(file, async () => ({ backup_path: (await backup(file, roots, signal)).path, original_path: file }))
}

/** Product-owned writes only. Does not claim to intercept arbitrary native shell/Python writes. */
export function writeAssistantFile(
  file: string,
  data: Buffer | string,
  roots: string[],
  options: { overwrite?: boolean; signal?: AbortSignal; approve?: (file: string) => Promise<boolean> } = {}
) {
  return exclusive(file, async () => {
    options.signal?.throwIfAborted()
    await assertSafeOutput(file, roots)
    const before = await existingFile(file)
    let backupPath: string | undefined
    if (before) {
      if (options.overwrite !== true)
        throw new Error('File already exists. Use a new filename, or explicitly request overwrite with a backup')
      if (!options.approve || !(await options.approve(file)))
        throw new Error('Overwrite was not approved; original file is unchanged')
      options.signal?.throwIfAborted()
      await assertSafeOutput(file, roots)
      const copy = await backup(file, roots, options.signal)
      backupPath = copy.path
      if (!unchanged(before, copy.before))
        throw new Error(`File changed while awaiting approval; original was not overwritten. Backup: ${backupPath}`)
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await assertSafeOutput(file, roots)
    const stage = path.join(path.dirname(file), `.zen-write-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(stage, data, { flag: 'wx' })
      options.signal?.throwIfAborted()
      await assertSafeOutput(file, roots)
      if (before) {
        const current = await existingFile(file)
        if (!current || !unchanged(before, current))
          throw new Error(`File changed before replacement; original was not overwritten. Backup: ${backupPath}`)
        await fs.rename(stage, file)
      } else {
        // Linking publishes a complete file atomically and never overwrites a competing writer.
        await fs.link(stage, file)
      }
    } finally {
      await fs.unlink(stage).catch(() => undefined)
    }
    return { backup_path: backupPath, write_mode: before ? 'replaced-with-backup' : 'new-file' }
  })
}
