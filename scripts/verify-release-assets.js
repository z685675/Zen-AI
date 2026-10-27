const fs = require('node:fs')
const path = require('node:path')

function verifyReleaseAssets(release, tag, profile) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || release.tagName !== tag) throw new Error('Release tag mismatch')
  if (typeof release.body !== 'string' || !release.body.trim()) throw new Error('Release notes are missing')
  if (!/^\d+$/.test(profile)) throw new Error('Invalid Python profile')
  const version = tag.slice(1)
  const required = ['latest.yml', 'latest-mac.yml', 'hotpatch-base-win32.json', 'hotpatch-base-darwin.json']
  for (const arch of ['x64', 'arm64']) {
    for (const kind of ['setup', 'portable']) required.push(`Zen-AI-${version}-windows-${arch}-${kind}.exe`)
    for (const ext of ['dmg', 'zip']) required.push(`Zen-AI-${version}-macos-${arch}.${ext}`)
  }
  for (const target of ['windows-x64', 'macos-x64', 'macos-arm64']) {
    const runtime = `Zen-AI-Python-Runtime-p${profile}-${target}.zip`
    required.push(runtime, `${runtime}.sha256`)
  }
  const assets = new Map((release.assets ?? []).map((asset) => [asset.name, asset]))
  const missing = required.filter((name) => !Number.isFinite(assets.get(name)?.size) || assets.get(name).size <= 0)
  if (missing.length) throw new Error(`Release is incomplete: ${missing.join(', ')}`)
  return required.length
}

if (require.main === module) {
  const [file, tag] = process.argv.slice(2)
  if (!file || !tag) throw new Error('Usage: node scripts/verify-release-assets.js release.json vX.Y.Z')
  const profileSource = fs.readFileSync(
    path.join(__dirname, '../src/main/services/python/ManagedPythonConfig.ts'),
    'utf8'
  )
  const profile = profileSource.match(/MANAGED_PYTHON_PROFILE_VERSION\s*=\s*['"](\d+)['"]/)?.[1]
  const count = verifyReleaseAssets(JSON.parse(fs.readFileSync(file, 'utf8')), tag, profile)
  process.stdout.write(`Verified ${count} required release assets for ${tag}.\n`)
}

module.exports = { verifyReleaseAssets }
