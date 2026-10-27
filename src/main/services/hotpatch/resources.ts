import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { HOTPATCH_LIMITS } from '@shared/hotpatch'

export interface SnapshotFile {
  path: string
  size: number
  sha256: string
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

export function snapshotContentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export function safeSnapshotPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/[\\:\x00-\x1f\x7f%?#]/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part)) &&
    !value
      .split('/')
      .some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$|conin\$|conout\$)(?:\.|$)/i.test(part))
  )
}

/** file: CSP 'self' alone is not a directory sandbox. Never execute user/downloaded files. */
export function createSecureFileFallback(originalRoot: string, fetcher: (request: Request) => Promise<Response>) {
  const root = path.resolve(originalRoot)
  return async (request: Request): Promise<Response> => {
    let inside = false
    try {
      const relative = path.relative(root, fileURLToPath(request.url))
      inside =
        relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    } catch {
      return new Response(null, { status: 403 })
    }
    if (inside) return fetcher(request)
    const pathname = new URL(request.url).pathname.toLowerCase()
    if (
      ['script', 'worker', 'sharedworker', 'serviceworker', 'document', 'iframe', 'style'].includes(
        request.destination
      ) ||
      /\.(?:html?|xhtml|js|mjs|cjs|wasm|css)$/.test(pathname)
    )
      return new Response(null, { status: 403 })
    const response = await fetcher(request)
    const headers = new Headers(response.headers)
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox")
    return new Response(response.body, { status: response.status, headers })
  }
}

function relativeResource(root: string, target: string): string | undefined {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return
  return relative.split(path.sep).join('/')
}

/** Reads verified bytes, not a file URL: later writes to userData cannot bypass the hash check. */
export async function readSnapshotFile(root: string, entry: SnapshotFile): Promise<Buffer> {
  if (
    !safeSnapshotPath(entry.path) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    entry.size > HOTPATCH_LIMITS.fileBytes
  )
    throw new Error('Invalid snapshot path or size')
  const resolvedRoot = path.resolve(root)
  const rootStat = await lstat(resolvedRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Snapshot root is not a directory')
  let cursor = resolvedRoot
  for (const part of entry.path.split('/')) {
    cursor = path.join(cursor, part)
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Snapshot symbolic links are forbidden')
  }
  const actualRoot = await realpath(resolvedRoot)
  const actualFile = await realpath(cursor)
  if (relativeResource(actualRoot, actualFile) !== entry.path) throw new Error('Snapshot path escaped its root')
  const handle = await open(cursor, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.size)
      throw new Error('Snapshot file size/type mismatch')
    const bytes = Buffer.alloc(entry.size)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!result.bytesRead) throw new Error('Truncated snapshot file')
      offset += result.bytesRead
    }
    if (
      (await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead ||
      createHash('sha256').update(bytes).digest('hex') !== entry.sha256
    )
      throw new Error('Snapshot file integrity mismatch')
    return bytes
  } finally {
    await handle.close()
  }
}

/** Keep the original file:// URL (and storage identity) for every application window. */
export function createSnapshotResourceHandler(options: {
  originalRoot: string
  snapshotRoot: string
  files: SnapshotFile[]
  fallback: (request: Request) => Promise<Response>
  onFailure?: (error: unknown) => void
  securityPolicy?: string
}): (request: Request) => Promise<Response> {
  const originalRoot = path.resolve(options.originalRoot)
  const files = new Map(options.files.map((entry) => [entry.path, entry]))
  return async (request) => {
    let relative: string | undefined
    try {
      const url = new URL(request.url)
      if (url.protocol !== 'file:' || url.hostname) return options.fallback(request)
      url.search = ''
      url.hash = ''
      relative = relativeResource(originalRoot, fileURLToPath(url))
    } catch {
      return new Response(null, { status: 400 })
    }
    // User attachments and independent views do not belong to this snapshot.
    if (relative === undefined) return options.fallback(request)
    try {
      const entry = files.get(relative)
      if (!entry || !safeSnapshotPath(relative)) throw new Error('Resource absent from complete snapshot')
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
      const bytes = await readSnapshotFile(options.snapshotRoot, entry)
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), {
        headers: {
          'Content-Type': snapshotContentType(entry.path),
          'Content-Length': String(bytes.length),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...(options.securityPolicy ? { 'Content-Security-Policy': options.securityPolicy } : {})
        }
      })
    } catch (error) {
      options.onFailure?.(error)
      // Never mix a missing/tampered patch chunk with the bundled version.
      return new Response(null, { status: 500 })
    }
  }
}
