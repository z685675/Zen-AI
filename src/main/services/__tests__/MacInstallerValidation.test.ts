import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { validateMacInstaller } from '../MacInstallerValidation'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zen-dmg-integrity-'))
  directories.push(directory)
  const file = path.join(directory, 'installer.dmg')
  const payload = Buffer.alloc(2048, 3)
  payload.write('koly', payload.length - 512, 'ascii')
  const expected = { sha512: createHash('sha512').update(payload).digest('base64'), size: payload.length }
  return { file, payload, expected }
}

describe('macOS installer integrity', () => {
  it('accepts a disk image only when it matches published size and SHA512', async () => {
    const f = await fixture()
    await writeFile(f.file, f.payload)
    expect(await validateMacInstaller(f.file, f.expected)).toBe(true)
    expect(await validateMacInstaller(f.file, { sha512: f.expected.sha512 })).toBe(true)
  })

  it.each(['html', 'empty', 'truncated', 'modified', 'wrong-size', 'wrong-hash', 'missing'])(
    'rejects %s',
    async (kind) => {
      const f = await fixture()
      let payload = Buffer.from(f.payload)
      if (kind === 'html') payload = Buffer.from('<html>not a disk image</html>')
      if (kind === 'empty') payload = Buffer.alloc(0)
      if (kind === 'truncated') payload = payload.subarray(0, payload.length - 30)
      if (kind === 'modified') payload[10] ^= 255
      if (kind === 'wrong-size') f.expected.size++
      if (kind === 'wrong-hash') f.expected.sha512 = 'invalid checksum'
      if (kind !== 'missing') await writeFile(f.file, payload)
      expect(await validateMacInstaller(f.file, f.expected)).toBe(false)
    }
  )
})
