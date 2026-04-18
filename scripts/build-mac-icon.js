const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const projectRoot = path.join(__dirname, '..')
const buildDir = path.join(projectRoot, 'build')

function resolveAppBuilderBinary() {
  const candidatePackageJsonPaths = [
    path.join(projectRoot, 'node_modules', 'app-builder-bin', 'package.json'),
    path.join(
      projectRoot,
      'node_modules',
      '.pnpm',
      'app-builder-bin@5.0.0-alpha.12',
      'node_modules',
      'app-builder-bin',
      'package.json'
    )
  ]

  const packageJsonPath = candidatePackageJsonPaths.find((candidate) => fs.existsSync(candidate))

  if (!packageJsonPath) {
    throw new Error('app-builder-bin package.json not found in node_modules')
  }

  const packageDir = path.dirname(packageJsonPath)

  if (process.platform === 'win32') {
    return path.join(packageDir, 'win', process.arch === 'arm64' ? 'arm64' : 'x64', 'app-builder.exe')
  }

  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') {
      return path.join(packageDir, 'mac', 'app-builder_arm64')
    }
    return path.join(packageDir, 'mac', 'app-builder_amd64')
  }

  return path.join(packageDir, 'linux', process.arch === 'arm64' ? 'arm64' : 'x64', 'app-builder')
}

function findSourcePng(inputPath) {
  const resolved = path.resolve(inputPath)

  if (!fs.existsSync(resolved)) {
    throw new Error(`Input path does not exist: ${resolved}`)
  }

  const stats = fs.statSync(resolved)
  if (stats.isFile()) {
    return resolved
  }

  const candidates = fs
    .readdirSync(resolved)
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .map((name) => path.join(resolved, name))
    .sort((left, right) => {
      const leftScore = /1024/.test(path.basename(left)) ? 1 : 0
      const rightScore = /1024/.test(path.basename(right)) ? 1 : 0
      if (leftScore !== rightScore) {
        return rightScore - leftScore
      }
      return fs.statSync(right).size - fs.statSync(left).size
    })

  if (candidates.length === 0) {
    throw new Error(`No PNG files found in directory: ${resolved}`)
  }

  return candidates[0]
}

function main() {
  const inputArg = process.argv[2] || path.join(buildDir, 'icon.png')
  const sourcePng = findSourcePng(inputArg)
  const appBuilderBinary = resolveAppBuilderBinary()

  if (!fs.existsSync(appBuilderBinary)) {
    throw new Error(`app-builder binary not found: ${appBuilderBinary}`)
  }

  execFileSync(appBuilderBinary, ['icon', '--format', 'icns', '--input', sourcePng, '--out', buildDir], {
    stdio: 'inherit'
  })

  console.log(`Generated mac icon from ${sourcePng}`)
}

main()
