const fs = require('node:fs')
const path = require('node:path')
const semver = require('semver')

// Only GitHub's published stable releases enter the public/offline archive.
// Tags and draft Markdown files are not evidence of publication.
function buildReleaseHistory(pages, now = new Date().toISOString()) {
  if (!Array.isArray(pages)) throw new Error('Expected GitHub release pages')
  const entries = new Map()
  for (const release of pages.flat()) {
    if (!release || typeof release !== 'object') continue
    const version = (release.tag_name ?? release.tagName ?? '').replace(/^v/, '')
    const date = release.published_at ?? release.publishedAt
    if (
      release.draft === true ||
      release.isDraft === true ||
      release.prerelease === true ||
      release.isPrerelease === true ||
      !/^\d+\.\d+\.\d+$/.test(version) ||
      !semver.valid(version) ||
      typeof date !== 'string' ||
      !Number.isFinite(Date.parse(date))
    )
      continue
    entries.set(version, {
      version,
      releaseDate: new Date(date).toISOString(),
      notes: typeof release.body === 'string' ? release.body.trim() : ''
    })
  }
  return {
    schemaVersion: 1,
    updatedAt: now,
    entries: [...entries.values()].sort((a, b) => semver.rcompare(a.version, b.version))
  }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const input = args[args.indexOf('--input') + 1]
  const output = args[args.indexOf('--output') + 1]
  if (!args.includes('--input') || !args.includes('--output') || !input || !output)
    throw new Error('Usage: build-release-history.js --input releases.json --output history.json')
  const history = buildReleaseHistory(JSON.parse(fs.readFileSync(input, 'utf8')))
  if (!history.entries.length) throw new Error('No published stable release history found')
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(history, null, 2)}\n`)
  console.log(`[release-history] Archived ${history.entries.length} published versions`)
}

module.exports = { buildReleaseHistory }
