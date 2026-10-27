import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')

import { StudioAssetCache } from '../StudioAssetCache'

const directories: string[] = []
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), 'zen-studio-assets-'))
  directories.push(path)
  return path
}
afterEach(() => {
  vi.useRealTimers()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('studio asset acceleration index', () => {
  it('persists content mappings across restarts and isolates credentials and changed images', () => {
    const path = directory()
    const bytes = Buffer.from('private image contents')
    const scope = 'a'.repeat(64)
    const id = 'b'.repeat(64)
    new StudioAssetCache(path).forScope(scope).remember(bytes, id)
    const restored = new StudioAssetCache(path)
    expect(restored.forScope(scope).find(bytes)).toBe(id)
    expect(restored.forScope('c'.repeat(64)).find(bytes)).toBeUndefined()
    expect(restored.forScope(scope).find(Buffer.from('changed'))).toBeUndefined()
    expect(readFileSync(join(path, 'studio-assets.json'), 'utf8')).not.toContain('private image contents')
    restored.forScope(scope).forget(bytes)
    expect(new StudioAssetCache(path).forScope(scope).find(bytes)).toBeUndefined()
  })

  it('remembers the normalized copy of a generated result without replacing another account mapping', () => {
    const cache = new StudioAssetCache(directory())
    const first = cache.forScope('a'.repeat(64))
    const second = cache.forScope('b'.repeat(64))
    const original = Buffer.from('original')
    const normalized = Buffer.from('normalized')
    first.remember(original, 'c'.repeat(64))
    second.remember(normalized, 'd'.repeat(64))
    first.alias(original, normalized)
    expect(first.find(normalized)).toBe('c'.repeat(64))
    expect(second.find(normalized)).toBe('d'.repeat(64))
  })

  it('ignores a damaged cache and expires old mappings without affecting task storage', () => {
    const path = directory()
    writeFileSync(join(path, 'studio-assets.json'), '{broken')
    const cache = new StudioAssetCache(path).forScope('a'.repeat(64))
    const bytes = Buffer.from('image')
    expect(cache.find(bytes)).toBeUndefined()
    cache.remember(bytes, 'b'.repeat(64))
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 31 * 24 * 3600000)
    expect(cache.find(bytes)).toBeUndefined()
    expect(new StudioAssetCache(path).forScope('a'.repeat(64)).find(bytes)).toBeUndefined()
  })
})
