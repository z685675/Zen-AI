const fs = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')

const archives = process.argv.slice(2)
const requiredPackages = ['archiver']

if (archives.length === 0) {
  console.error('Usage: check-packaged-runtime-dependencies.js <app.asar> [...]')
  process.exit(1)
}

let failed = false

for (const archive of archives) {
  const archivePath = path.resolve(archive)

  if (!fs.existsSync(archivePath)) {
    console.error(`[runtime-deps] Packaged archive does not exist: ${archivePath}`)
    failed = true
    continue
  }

  const requireFromArchive = createRequire(path.join(archivePath, 'out', 'main', 'index.js'))
  const mainBundle = fs.readFileSync(path.join(archivePath, 'out', 'main', 'index.js'), 'utf8')

  for (const packageName of requiredPackages) {
    const packageParts = packageName.split('/')
    const candidates = [
      path.join(archivePath, 'node_modules', ...packageParts, 'package.json'),
      path.join(`${archivePath}.unpacked`, 'node_modules', ...packageParts, 'package.json')
    ]

    const packageIsIncluded = candidates.some((candidate) => fs.existsSync(candidate))
    const unresolvedRequire = new RegExp(`require\\((['"])${packageName}\\1\\)`).test(mainBundle)

    if (!packageIsIncluded && unresolvedRequire) {
      console.error(`[runtime-deps] ${packageName} remains an unresolved runtime require in ${archivePath}`)
      failed = true
      continue
    }

    if (packageIsIncluded) {
      try {
        requireFromArchive(packageName)
      } catch (error) {
        console.error(`[runtime-deps] Cannot load ${packageName} from ${archivePath}: ${error.message}`)
        failed = true
      }
    }
  }
}

if (failed) process.exit(1)

console.log(`[runtime-deps] Verified ${requiredPackages.join(', ')} in ${archives.length} packaged archive(s).`)
