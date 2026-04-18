const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

function findFilesRecursively(rootDir, fileName) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return []
  }

  const matches = []

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name)

    if (entry.isDirectory()) {
      matches.push(...findFilesRecursively(fullPath, fileName))
      continue
    }

    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      matches.push(fullPath)
    }
  }

  return matches
}

function findWindowsExecutable(appOutDir) {
  if (!fs.existsSync(appOutDir)) {
    return null
  }

  const executable = fs
    .readdirSync(appOutDir)
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .find((name) => !name.toLowerCase().startsWith('uninstall'))

  return executable ? path.join(appOutDir, executable) : null
}

function patchWindowsIcon(appOutDir) {
  const exePath = findWindowsExecutable(appOutDir)
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')
  const cacheRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign')
    : null

  if (!exePath || !fs.existsSync(iconPath)) {
    return
  }

  const rceditCandidates = findFilesRecursively(cacheRoot, 'rcedit-x64.exe').sort((left, right) => {
    return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs
  })

  if (rceditCandidates.length === 0) {
    console.warn('[after-pack] skipped icon patch because rcedit-x64.exe was not found in electron-builder cache')
    return
  }

  try {
    execFileSync(rceditCandidates[0], [exePath, '--set-icon', iconPath], { stdio: 'inherit' })
    console.log(`[after-pack] patched Windows executable icon: ${exePath}`)
  } catch (error) {
    console.warn(`[after-pack] failed to patch Windows executable icon: ${error.message}`)
  }
}

exports.default = async function (context) {
  const platform = context.packager.platform.name
  if (platform === 'windows') {
    fs.rmSync(path.join(context.appOutDir, 'LICENSE.electron.txt'), { force: true })
    fs.rmSync(path.join(context.appOutDir, 'LICENSES.chromium.html'), { force: true })
    patchWindowsIcon(context.appOutDir)
  }
}
