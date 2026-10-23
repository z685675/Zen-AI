// Headless, test-only environment preparation. Never loaded by the installed app.
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { app } = require('electron')

const fatal = (error) => {
  process.stderr.write(`Python preflight startup failed: ${error?.stack || error}\n`)
  app.exit(1)
}
process.on('uncaughtException', fatal)
process.on('unhandledRejection', fatal)

const requestPath = fs.realpathSync(process.env.ZEN_QUALITY_PYTHON_REQUEST)
const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))
const project = fs.realpathSync(request.root)
const setup = path.dirname(requestPath)
const reports = fs.realpathSync(path.join(project, 'local/quality-reports'))
const relative = path.relative(reports, fs.realpathSync(setup))
if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
  throw new Error('Invalid Python preflight directory')
app.setAppPath(project)
app.setName('ZenAIQualityPython')
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version
app.disableHardwareAcceleration()
for (const key of ['appData', 'userData', 'home', 'documents', 'desktop', 'downloads', 'temp', 'logs', 'sessionData']) {
  const directory = path.join(setup, 'instance', key)
  fs.mkdirSync(directory, { recursive: true })
  app.setPath(key, directory)
}

void app.whenReady().then(async () => {
  let exitCode = 0
  let logger
  try {
    const requireProject = createRequire(path.join(project, 'package.json'))
    process.env.TSX_TSCONFIG_PATH = path.join(project, 'tsconfig.node.json')
    requireProject('tsx/cjs/api').register()
    logger = require('./../../src/main/services/LoggerService.ts').loggerService
    const { prepareInElectron } = require('./python-preflight.ts')
    await prepareInElectron(request, setup)
  } catch (error) {
    exitCode = 1
    process.stderr.write(`Python preflight failed: ${error.stack || error}\n`)
  } finally {
    try {
      await logger?.finish()
    } catch (error) {
      exitCode = 1
      process.stderr.write(`Python preflight log cleanup failed: ${error}\n`)
    }
    app.exit(exitCode)
  }
})
