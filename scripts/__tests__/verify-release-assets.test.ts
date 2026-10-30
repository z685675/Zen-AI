import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const { verifyReleaseAssets } = createRequire(import.meta.url)('../verify-release-assets.js')

function release() {
  const names = [
    'latest.yml',
    'latest-mac.yml',
    'hotpatch-base-win32.json',
    'hotpatch-base-darwin.json',
    'hotpatch-runtime-win32.zip',
    'hotpatch-runtime-darwin.zip'
  ]
  for (const arch of ['x64', 'arm64']) {
    for (const kind of ['setup', 'portable']) names.push(`Zen-AI-1.1.76-windows-${arch}-${kind}.exe`)
    for (const ext of ['dmg', 'zip']) names.push(`Zen-AI-1.1.76-macos-${arch}.${ext}`)
  }
  for (const target of ['windows-x64', 'macos-x64', 'macos-arm64']) {
    const name = `Zen-AI-Python-Runtime-p2-${target}.zip`
    names.push(name, `${name}.sha256`)
  }
  return { tagName: 'v1.1.76', body: 'Reviewed release notes', assets: names.map((name) => ({ name, size: 100 })) }
}

describe('release publication gate', () => {
  it('requires all platforms and the current Python runtime profile', () => {
    expect(verifyReleaseAssets(release(), 'v1.1.76', '2')).toBe(20)
  })
  it.each([
    'hotpatch-runtime-win32.zip',
    'hotpatch-runtime-darwin.zip',
    'Zen-AI-1.1.76-macos-arm64.zip',
    'Zen-AI-1.1.76-windows-arm64-setup.exe',
    'Zen-AI-Python-Runtime-p2-windows-x64.zip',
    'Zen-AI-Python-Runtime-p2-macos-x64.zip.sha256'
  ])('blocks a missing %s', (name) => {
    const incomplete = release()
    incomplete.assets = incomplete.assets.filter((asset) => asset.name !== name)
    expect(() => verifyReleaseAssets(incomplete, 'v1.1.76', '2')).toThrow('incomplete')
  })
  it('rejects empty assets, obsolete runtime profiles, wrong tags and missing release notes', () => {
    const empty = release()
    empty.assets[0].size = 0
    expect(() => verifyReleaseAssets(empty, 'v1.1.76', '2')).toThrow('incomplete')
    expect(() => verifyReleaseAssets(release(), 'v1.1.76', '1')).toThrow('incomplete')
    expect(() => verifyReleaseAssets(release(), 'v1.1.77', '2')).toThrow('mismatch')
    expect(() => verifyReleaseAssets({ ...release(), body: '' }, 'v1.1.76', '2')).toThrow('notes')
  })
})
