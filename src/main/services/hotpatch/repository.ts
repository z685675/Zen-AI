import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rename, rm, statfs } from 'node:fs/promises'
import path from 'node:path'

import { HOTPATCH_LIMITS, type HotpatchArtifact, type HotpatchBase, HotpatchError } from '@shared/hotpatch'

import { extractSnapshot, verifySnapshot } from './archive'
import { downloadArchive, fetchHotpatch, type HotpatchFetch, readBoundedResponse } from './download'
import type { SnapshotReference } from './state'
import { type HotpatchTrust, sha256, validateArtifact, verifyEnvelope } from './verification'

export interface VerifiedSnapshot {
  root: string
  artifact: HotpatchArtifact
}
export class SnapshotRepository {
  constructor(
    private readonly options: {
      root: string
      base: HotpatchBase
      builtin: HotpatchArtifact['files']
      trust: HotpatchTrust
      allowed: readonly string[]
      fetcher: HotpatchFetch
    }
  ) {}

  private location(reference: SnapshotReference): string {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(reference.patchId) ||
      !/^[a-f0-9]{64}$/.test(reference.manifestSha256)
    )
      throw new HotpatchError('path', 'Invalid local snapshot reference')
    return path.join(this.options.root, `${reference.patchId}-${reference.manifestSha256}`)
  }

  async prune(pinned: Array<SnapshotReference | null>): Promise<void> {
    const root = path.resolve(this.options.root)
    if (path.resolve(await realpath(root)) !== root || (await lstat(root)).isSymbolicLink())
      throw new HotpatchError('storage', 'Unsafe patch cleanup root')
    const keep = new Set(
      pinned.filter((item): item is SnapshotReference => item !== null).map((item) => this.location(item))
    )
    const candidates: Array<{ directory: string; mtime: number; staging: boolean }> = []
    for (const entry of (await readdir(root, { withFileTypes: true })).slice(0, 1000)) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !/^(?:staging-[a-f0-9]{32}|[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}-[a-f0-9]{64})$/.test(entry.name)
      )
        continue
      const directory = path.resolve(root, entry.name)
      if (keep.has(directory)) continue
      const stat = await lstat(directory)
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        path.dirname(directory) !== root ||
        path.resolve(await realpath(directory)) !== directory
      )
        continue
      candidates.push({
        directory,
        mtime: stat.mtimeMs,
        staging: entry.name.startsWith('staging-') && /^staging-[a-f0-9]{32}$/.test(entry.name)
      })
    }
    let unpinned = 0
    for (const item of candidates.sort((a, b) => b.mtime - a.mtime)) {
      if (item.staging ? Date.now() - item.mtime < 24 * 60 * 60 * 1000 : unpinned++ < 2) continue
      // Only validated direct children of the dedicated patch cache; never user workspaces/data.
      await rm(item.directory, { recursive: true, force: false })
    }
  }

  async load(reference: SnapshotReference): Promise<VerifiedSnapshot> {
    const directory = this.location(reference),
      metadata = path.join(directory, 'manifest.json')
    for (const folder of [this.options.root, directory]) {
      const stat = await lstat(folder)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new HotpatchError('path', 'Invalid snapshot storage directory')
    }
    const stat = await lstat(metadata)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > HOTPATCH_LIMITS.manifestBytes)
      throw new HotpatchError('integrity', 'Invalid stored artifact metadata')
    const handle = await open(metadata, 'r')
    let bytes: Buffer
    try {
      // A bounded buffer avoids a grow-after-stat readFile allocation.
      const buffer = Buffer.alloc(stat.size + 1)
      let offset = 0
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (!result.bytesRead) break
        offset += result.bytesRead
      }
      if (offset !== stat.size) throw new HotpatchError('integrity', 'Stored metadata changed during read')
      bytes = buffer.subarray(0, offset)
    } finally {
      await handle.close()
    }
    if (sha256(bytes) !== reference.manifestSha256)
      throw new HotpatchError('integrity', 'Stored manifest digest mismatch')
    const artifact = verifyEnvelope(bytes, 'artifact', this.options.trust).value
    validateArtifact(artifact, this.options.base, this.options.builtin)
    if (artifact.patchId !== reference.patchId) throw new HotpatchError('compatibility', 'Snapshot identity mismatch')
    if ((await readdir(directory)).sort().join(',') !== 'files,manifest.json')
      throw new HotpatchError('integrity', 'Unexpected snapshot metadata')
    const root = path.join(directory, 'files')
    await verifySnapshot(root, artifact)
    return { root, artifact }
  }

  async install(target: SnapshotReference & { manifestUrl: string }, signal: AbortSignal): Promise<VerifiedSnapshot> {
    const destination = this.location(target)
    let exists = false
    try {
      await lstat(destination)
      exists = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // A missing file inside an existing artifact is corruption, not permission to replace it.
    if (exists) return this.load(target)
    const metadataResponse = await fetchHotpatch(this.options.fetcher, target.manifestUrl, this.options.allowed, signal)
    const bytes = await readBoundedResponse(metadataResponse, HOTPATCH_LIMITS.manifestBytes)
    if (sha256(bytes) !== target.manifestSha256)
      throw new HotpatchError('integrity', 'Downloaded manifest digest mismatch')
    const artifact = verifyEnvelope(bytes, 'artifact', this.options.trust).value
    validateArtifact(artifact, this.options.base, this.options.builtin)
    if (artifact.patchId !== target.patchId) throw new HotpatchError('compatibility', 'Published target mismatch')
    await mkdir(this.options.root, { recursive: true, mode: 0o700 })
    const root = await lstat(this.options.root)
    if (!root.isDirectory() || root.isSymbolicLink()) throw new HotpatchError('storage', 'Unsafe snapshot storage root')
    const space = await statfs(this.options.root)
    if (space.bavail * space.bsize < artifact.expandedSize + artifact.archive.size + 128 * 1024 * 1024)
      throw new HotpatchError('storage', 'Insufficient disk space for atomic patch installation')
    const temporary = path.join(this.options.root, `staging-${randomBytes(16).toString('hex')}`)
    await mkdir(temporary, { mode: 0o700 })
    try {
      const archive = path.join(temporary, 'download.zip'),
        files = path.join(temporary, 'files')
      await mkdir(files, { mode: 0o700 })
      await downloadArchive(
        await fetchHotpatch(this.options.fetcher, artifact.archive.url, this.options.allowed, signal),
        archive,
        artifact.archive,
        signal
      )
      await extractSnapshot(archive, files, artifact, signal)
      await verifySnapshot(files, artifact)
      const manifest = await open(path.join(temporary, 'manifest.json'), 'wx', 0o600)
      try {
        await manifest.writeFile(bytes)
        await manifest.sync()
      } finally {
        await manifest.close()
      }
      await rm(archive)
      signal.throwIfAborted()
      await rename(temporary, destination)
      return await this.load(target)
    } finally {
      // The only recursive deletion target is the fresh random staging directory created above.
      await rm(temporary, { recursive: true, force: true }).catch(() => {})
    }
  }
}
