const fs = require('node:fs')
const path = require('node:path')
const YAML = require('yaml')
const { buildReleaseHistory } = require('./build-release-history')

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function normalizeRelease(release) {
  return {
    tagName: release.tagName || release.tag_name || '',
    name: release.name || '',
    body: release.body || '',
    publishedAt: release.publishedAt || release.published_at || '',
    createdAt: release.createdAt || release.created_at || ''
  }
}

function findReleaseNotes(release) {
  if (typeof release.body === 'string' && release.body.trim()) {
    return release.body.trim()
  }
  return `Release notes for ${release.tagName} are not provided yet.`
}

function collectMetadataFiles(dirPath) {
  return fs
    .readdirSync(dirPath)
    .filter((fileName) => /^latest.*\.yml$/i.test(fileName))
    .map((fileName) => path.join(dirPath, fileName))
}

function patchMetadataFile(filePath, release) {
  const raw = fs.readFileSync(filePath, 'utf8')
  const data = YAML.parse(raw) || {}

  data.version = release.tagName.replace(/^v/, '')
  data.releaseDate = release.publishedAt || release.createdAt || new Date().toISOString()
  data.releaseName = release.name?.trim() || `Zen AI ${release.tagName}`
  data.releaseNotes = findReleaseNotes(release)

  fs.writeFileSync(filePath, YAML.stringify(data), 'utf8')
  console.log(`[sync-release-metadata] updated ${path.basename(filePath)}`)
}

function writeReleaseBodyFile(workDir, release) {
  const releaseBodyPath = path.join(workDir, '.release-body.md')
  fs.writeFileSync(releaseBodyPath, `${findReleaseNotes(release)}\n`, 'utf8')
  return releaseBodyPath
}

function main() {
  const workDir = process.cwd()
  const releaseJsonPath = requiredEnv('RELEASE_JSON_PATH')
  const assetsDir = requiredEnv('RELEASE_ASSETS_DIR')

  const selectedRelease = readJson(path.resolve(workDir, releaseJsonPath))
  const release = normalizeRelease(selectedRelease)
  const historyPages = readJson(path.resolve(workDir, requiredEnv('RELEASE_HISTORY_JSON_PATH')))
  if (!Array.isArray(historyPages)) throw new Error('Invalid published release history source')
  const history = buildReleaseHistory([...historyPages.flat(), selectedRelease])
  if (
    !history.entries.some((entry) => entry.version === release.tagName.replace(/^v/, '')) ||
    selectedRelease.isDraft === true ||
    selectedRelease.draft === true ||
    selectedRelease.isPrerelease === true ||
    selectedRelease.prerelease === true ||
    !release.publishedAt
  )
    throw new Error('Only a published stable release can update download metadata')
  const metadataFiles = collectMetadataFiles(path.resolve(workDir, assetsDir))

  if (metadataFiles.length === 0) {
    throw new Error(`No latest*.yml files found under ${assetsDir}`)
  }

  for (const filePath of metadataFiles) {
    patchMetadataFile(filePath, release)
  }
  fs.writeFileSync(
    path.join(path.resolve(workDir, assetsDir), 'release-history.json'),
    `${JSON.stringify(history, null, 2)}\n`,
    'utf8'
  )

  const releaseBodyPath = writeReleaseBodyFile(workDir, release)
  console.log(`[sync-release-metadata] wrote ${path.relative(workDir, releaseBodyPath)}`)
}

main()
