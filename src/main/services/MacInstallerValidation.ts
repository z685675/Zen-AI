import { createHash, timingSafeEqual } from 'node:crypto'
import { open } from 'node:fs/promises'

export interface MacInstallerIntegrity {
  sha512: string
  size?: number
}

export async function validateMacInstaller(filePath: string, expected: MacInstallerIntegrity): Promise<boolean> {
  const digest = Buffer.from(expected.sha512, 'base64')
  if (digest.length !== 64 || digest.toString('base64') !== expected.sha512) return false
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(filePath, 'r')
    const before = await file.stat()
    if (!before.isFile() || before.size < 512 || (expected.size !== undefined && before.size !== expected.size)) {
      return false
    }
    // A UDIF disk image has a 512-byte trailer beginning with "koly". Reject
    // error pages and truncated payloads before reading the entire cached file.
    const trailer = Buffer.alloc(512)
    const { bytesRead } = await file.read(trailer, 0, trailer.length, before.size - trailer.length)
    if (bytesRead !== trailer.length || trailer.toString('ascii', 0, 4) !== 'koly') return false
    const hash = createHash('sha512')
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk)
    const after = await file.stat()
    return before.size === after.size && before.mtimeMs === after.mtimeMs && timingSafeEqual(hash.digest(), digest)
  } catch {
    return false
  } finally {
    await file?.close()
  }
}
