const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const local = path.join(root, 'local')

async function runFixture(mode, iterations) {
  fs.mkdirSync(local, { recursive: true })
  const profile = fs.mkdtempSync(path.join(local, 'libsql-lifecycle-'))
  const env = {
    ...process.env,
    ZEN_LIBSQL_TEST_PROFILE: profile,
    ZEN_LIBSQL_TEST_ITERATIONS: String(iterations),
    ZEN_LIBSQL_TEST_MODE: mode
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [path.join(__dirname, 'fixtures', 'libsql-lifecycle.cjs')], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (data) => {
    stdout += data
    process.stdout.write(data)
  })
  child.stderr.on('data', (data) => {
    stderr += data
  })
  const timer = setTimeout(() => child.kill(), 180_000)
  let exit
  try {
    exit = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
  } finally {
    clearTimeout(timer)
  }
  assert.equal(exit.code, 0, `${mode}: Electron exited with ${exit.code}/${exit.signal}. ${stderr.slice(-3000)}`)
  const line = stdout.split(/\r?\n/).find((line) => line.startsWith('ZEN_LIBSQL_RESULT '))
  assert.ok(line, `${mode}: Electron did not complete the lifecycle test`)
  const result = JSON.parse(line.slice('ZEN_LIBSQL_RESULT '.length))
  // Only delete this invocation's generated profile, inside the repo's local
  // test directory. Preserve failed fixtures for diagnosis.
  const resolved = fs.realpathSync(profile)
  assert.equal(path.dirname(resolved), fs.realpathSync(local))
  assert.ok(path.basename(resolved).startsWith('libsql-lifecycle-'))
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  return result
}

async function run() {
  const iterations = Number(process.argv[2] || 10000)
  const rounds = Number(process.argv[3] || 3)
  assert.ok(Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= 50000, 'Invalid iteration count')
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 10, 'Invalid round count')
  const results = []
  for (let round = 1; round <= rounds; round++) {
    process.stdout.write(`Native database stability round ${round}/${rounds}\n`)
    results.push(await runFixture('transactions', iterations))
  }
  results.push(await runFixture('close', 1))
  results.push(await runFixture('shutdown', 1))
  process.stdout.write(`${JSON.stringify({ status: 'passed', results })}\n`)
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  })
}

module.exports = { runFixture }
