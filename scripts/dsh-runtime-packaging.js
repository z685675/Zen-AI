const fs = require('node:fs')
const path = require('node:path')

const VERSION = '0.2.2-alpha.3'
const RESOURCE_FILES = ['package.json', 'package-lock.json', 'bootstrap.json', 'node.json', 'bridge.mjs']

function prepareDshPreviewRuntime(rootDir = path.join(__dirname, '..')) {
  const source = path.join(rootDir, 'resources', 'dsh-runtime')
  for (const name of RESOURCE_FILES) {
    if (!fs.statSync(path.join(source, name), { throwIfNoEntry: false })?.isFile())
      throw new Error(`DSH preview resource missing: ${name}`)
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8'))
  if (
    manifest.dependencies?.['@deepseek-ai/dsh'] !== VERSION ||
    lock.packages?.['node_modules/@deepseek-ai/dsh']?.version !== VERSION
  )
    throw new Error('DSH preview runtime version does not match the pinned lockfile')
  for (const [name, entry] of Object.entries(lock.packages || {})) {
    if (!name || entry.link) continue
    if (!entry.integrity || !entry.resolved?.startsWith('https://registry.npmjs.org/'))
      throw new Error(`DSH preview dependency is not integrity pinned to the official npm registry: ${name}`)
  }
  const bootstrap = JSON.parse(fs.readFileSync(path.join(source, 'bootstrap.json'), 'utf8'))
  if (!bootstrap.url.startsWith('https://registry.npmjs.org/npm/-/npm-') || !bootstrap.integrity.startsWith('sha512-'))
    throw new Error('DSH installer metadata is not integrity pinned')
  const node = JSON.parse(fs.readFileSync(path.join(source, 'node.json'), 'utf8'))
  if (!/^[\d.]+$/.test(node.version) || node.source !== `https://nodejs.org/dist/v${node.version}/SHASUMS256.txt`)
    throw new Error('DSH Node metadata is not pinned to official checksums')
  for (const platform of ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64']) {
    if (!/^[a-f0-9]{64}$/.test(node.artifacts?.[platform]?.sha256 || ''))
      throw new Error(`DSH Node artifact is not integrity pinned: ${platform}`)
  }
  return {
    source,
    files: RESOURCE_FILES,
    bytes: RESOURCE_FILES.reduce((sum, name) => sum + fs.statSync(path.join(source, name)).size, 0)
  }
}

function copyDshPreviewRuntime(context, rootDir = path.join(__dirname, '..')) {
  const { source, files } = prepareDshPreviewRuntime(rootDir)
  const destination = path.join(context.packager.getResourcesDir(context.appOutDir), 'dsh-runtime')
  fs.mkdirSync(destination, { recursive: true })
  // The 700+ MB dependency tree is installed only after the hidden preview is
  // explicitly unlocked. Never copy a developer's local node_modules here.
  for (const name of files) fs.copyFileSync(path.join(source, name), path.join(destination, name))
  return destination
}

module.exports = { prepareDshPreviewRuntime, copyDshPreviewRuntime }
