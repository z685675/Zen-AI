import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:os')
vi.unmock('node:path')

import { prepareOpenCodeOfflineConfig } from '../offline'

let temp: string
let bundle: string
let root: string
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-opencode-offline-test-'))
  bundle = path.join(temp, 'bundle')
  root = path.join(temp, 'private')
  await fs.mkdir(path.join(bundle, 'node_modules', '@opencode-ai', 'plugin'), { recursive: true })
  await fs.writeFile(
    path.join(bundle, 'node_modules', '@opencode-ai', 'plugin', 'package.json'),
    '{"version":"1.19.4"}'
  )
  await fs.writeFile(path.join(bundle, 'package.json'), '{"dependencies":{"@opencode-ai/plugin":"1.19.4"}}')
  await fs.writeFile(path.join(bundle, 'package-lock.json'), '{"lockfileVersion":3}')
})
afterEach(async () => {
  if (!temp) return
  if (path.dirname(temp) !== os.tmpdir() || !path.basename(temp).startsWith('zen-opencode-offline-test-'))
    throw new Error('Unexpected fixture path')
  await fs.rm(temp, { recursive: true, force: true })
})
describe('OpenCode real offline dependency installation', () => {
  it('links real bundled dependencies and preserves idempotence', async () => {
    await prepareOpenCodeOfflineConfig(root, bundle)
    await prepareOpenCodeOfflineConfig(root, bundle)
    expect(await fs.realpath(path.join(root, 'config/opencode/node_modules'))).toBe(
      await fs.realpath(path.join(bundle, 'node_modules'))
    )
    expect(await fs.readFile(path.join(root, 'config/opencode/package-lock.json'), 'utf8')).toContain('lockfileVersion')
  })
  it('fails explicitly when the installer did not include the pinned dependency', async () => {
    await expect(prepareOpenCodeOfflineConfig(root, path.join(temp, 'missing'))).rejects.toThrow('runtime:opencode')
  })
  it('never replaces an unexpected real dependency directory', async () => {
    const target = path.join(root, 'config/opencode/node_modules')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'keep.txt'), 'keep')
    await expect(prepareOpenCodeOfflineConfig(root, bundle)).rejects.toThrow('refusing to replace')
    expect(await fs.readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('keep')
  })
})
