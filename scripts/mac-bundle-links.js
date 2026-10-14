const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function visitLinks(directory, visit) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) visit(file)
    else if (entry.isDirectory()) visitLinks(file, visit)
  }
}

function realPathIfPresent(file) {
  try {
    return fs.realpathSync(file)
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return undefined
    throw error
  }
}

function validateCopySource(file, allowedRoots, ancestors = new Set()) {
  const target = realPathIfPresent(file)
  if (!target || !allowedRoots.some((root) => isInside(root, target)))
    throw new Error(`[mac-links] Unsafe or missing nested symlink source: ${file}`)
  if (!fs.statSync(target).isDirectory()) return
  if (ancestors.has(target)) throw new Error(`[mac-links] Circular nested symlink source: ${file}`)
  const nextAncestors = new Set([...ancestors, target])
  for (const name of fs.readdirSync(target)) validateCopySource(path.join(target, name), allowedRoots, nextAncestors)
}

// The dependency collector preserves source-relative pnpm links even though it
// hoists their destinations into app.asar.unpacked. Recover only that exact
// packaged dependency from the build tree, never an arbitrary missing target.
function sourceForUnpackedDependency(resources, file, projectRoot) {
  const modules = path.join(resources, 'app.asar.unpacked', 'node_modules')
  if (!isInside(modules, file)) return undefined
  const relative = path.relative(modules, file)
  const parts = relative.split(path.sep)
  const packageLength = parts[0].startsWith('@') ? 2 : 1
  const packageName = parts.slice(0, packageLength).join('/')
  const packageFile = parts.slice(packageLength)
  const candidates = [
    path.join(projectRoot, 'node_modules', relative),
    path.join(projectRoot, 'node_modules', '.pnpm', 'node_modules', relative)
  ]
  try {
    const projectRequire = createRequire(path.join(projectRoot, 'package.json'))
    candidates.push(path.join(path.dirname(projectRequire.resolve(`${packageName}/package.json`)), ...packageFile))
  } catch {
    // Packages without a public manifest can still be found at the paths above.
  }
  return candidates.map(realPathIfPresent).find(Boolean)
}

function prepareMacBundleLinks(resourcesDir, projectRoot) {
  const resources = fs.realpathSync(resourcesDir)
  const bundle = path.resolve(resources, '..', '..')
  if (
    path.basename(resources) !== 'Resources' ||
    path.basename(path.dirname(resources)) !== 'Contents' ||
    !bundle.endsWith('.app')
  )
    throw new Error(`[mac-links] Not an application Resources directory: ${resourcesDir}`)
  const project = fs.realpathSync(projectRoot)
  const allowedSources = [bundle, path.join(project, 'node_modules'), path.join(project, 'resources')]
  const materialized = []
  visitLinks(resources, (file) => {
    const link = fs.readlinkSync(file)
    const target = realPathIfPresent(file) || sourceForUnpackedDependency(resources, file, project)
    if (!target || !allowedSources.some((root) => isInside(root, target)))
      throw new Error(
        `[mac-links] Invalid resource symlink: ${file} -> ${link} (missing or outside allowed build resources)`
      )
    // A directory referring to itself/its parents would recurse while copying.
    if (fs.statSync(target).isDirectory() && isInside(target, file))
      throw new Error(`[mac-links] Circular resource symlink: ${file} -> ${link}`)
    validateCopySource(target, allowedSources)
    const staging = fs.mkdtempSync(path.join(path.dirname(file), '.zen-link-'))
    if (!isInside(resources, staging) || !path.basename(staging).startsWith('.zen-link-'))
      throw new Error(`[mac-links] Unexpected staging directory: ${staging}`)
    try {
      const replacement = path.join(staging, 'content')
      fs.cpSync(target, replacement, { recursive: true, dereference: true })
      // Unlink exactly this entry, never recursively remove its target.
      fs.unlinkSync(file)
      fs.renameSync(replacement, file)
      materialized.push(path.relative(bundle, file))
    } finally {
      fs.rmSync(staging, { recursive: true, force: true })
    }
  })
  verifyMacBundleLinks(bundle)
  return materialized
}

function verifyMacBundleLinks(bundleDir) {
  const bundle = fs.realpathSync(bundleDir)
  visitLinks(bundle, (file) => {
    const link = fs.readlinkSync(file)
    const target = realPathIfPresent(file)
    if (path.isAbsolute(link) || !target || !isInside(bundle, target))
      throw new Error(
        `[mac-links] Invalid bundle symlink: ${file} -> ${link} (must be a valid relative link inside the application)`
      )
  })
}

module.exports = { prepareMacBundleLinks, verifyMacBundleLinks }
