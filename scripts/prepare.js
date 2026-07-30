const { execFileSync } = require('node:child_process')

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

try {
  run('git', ['config', 'blame.ignoreRevsFile', '.git-blame-ignore-revs'])
} catch {
  console.warn('[prepare] Unable to configure Git blame ignores; continuing.')
}

if (process.env.CI) {
  console.log('[prepare] Skipping local Git hook installation in CI.')
  process.exit(0)
}

try {
  run(process.platform === 'win32' ? 'prek.cmd' : 'prek', ['install'])
} catch {
  console.warn('[prepare] prek is unavailable; local Git hooks were not installed.')
}
