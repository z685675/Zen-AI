import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

import { HOTPATCH_LIMITS, HotpatchError } from '@shared/hotpatch'

import { assertDownloadUrl } from './verification'

export type HotpatchFetch = (url: string, options: RequestInit) => Promise<Response>

/** The caller supplies Electron's controlled session.fetch; no model/provider headers are accepted. */
export async function fetchHotpatch(
  fetcher: HotpatchFetch,
  input: string,
  allowed: readonly string[],
  signal: AbortSignal
): Promise<Response> {
  let url = assertDownloadUrl(input, allowed)
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted()
    const response = await fetcher(url.href, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/octet-stream, application/json' },
      signal
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location || redirects === 3) throw new HotpatchError('network', 'Patch redirect limit exceeded')
      url = assertDownloadUrl(new URL(location, url).href, allowed)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new HotpatchError('network', 'Patch server did not return success')
    }
    // Electron fetch decodes HTTP content encoding. Bound and hash the decoded bytes below,
    // so a legitimate CDN gzip response works without allowing decompression bombs.
    return response
  }
  throw new HotpatchError('network', 'Patch redirect limit exceeded')
}

export async function readBoundedResponse(response: Response, maximum: number): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel()
    throw new HotpatchError('size', 'Patch metadata content length exceeds its limit')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new HotpatchError('network', 'Empty patch response')
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maximum) throw new HotpatchError('size', 'Patch metadata exceeds its limit')
      chunks.push(value)
    }
    if (!total) throw new HotpatchError('network', 'Empty patch response')
    return Buffer.concat(chunks, total)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function downloadArchive(
  response: Response,
  destination: string,
  expected: { size: number; sha256: string },
  signal: AbortSignal
): Promise<void> {
  if (expected.size > HOTPATCH_LIMITS.archiveBytes) throw new HotpatchError('size', 'Archive exceeds its limit')
  const handle = await open(destination, 'wx', 0o600)
  const reader = response.body?.getReader()
  if (!reader) {
    await handle.close()
    throw new HotpatchError('network', 'Empty archive response')
  }
  let total = 0
  const hash = createHash('sha256')
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > expected.size) throw new HotpatchError('size', 'Archive exceeded its signed byte size')
      hash.update(value)
      let offset = 0
      while (offset < value.length) {
        const result = await handle.write(value, offset, value.length - offset)
        if (!result.bytesWritten) throw new HotpatchError('storage', 'Archive write made no progress')
        offset += result.bytesWritten
      }
    }
    if (total !== expected.size || hash.digest('hex') !== expected.sha256)
      throw new HotpatchError('integrity', 'Archive hash or size mismatch')
    await handle.sync()
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    await handle.close()
  }
}
