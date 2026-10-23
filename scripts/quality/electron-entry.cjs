// Test-only entrypoint. Never copied into production bootstrap or loaded by normal users.
const fs = require('node:fs')
const path = require('node:path')
const { app, session, ipcMain } = require('electron')
process.on('uncaughtException', (error) => {
  process.stderr.write(`Quality isolated startup failed: ${error.stack || error}\n`)
  app.exit(1)
})

const root = fs.realpathSync(process.env.ZEN_QUALITY_INSTANCE)
if (
  !path.isAbsolute(root) ||
  fs.readFileSync(path.join(root, '.quality-instance'), 'utf8') !== 'zen-quality-isolated-v1'
) {
  throw new Error('Missing isolated quality instance marker')
}
const project = fs.realpathSync(process.env.ZEN_QUALITY_PROJECT)
app.setAppPath(project)
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version
app.setName('ZenAIQuality')
for (const key of ['appData', 'userData', 'home', 'documents', 'desktop', 'downloads', 'temp', 'logs', 'sessionData']) {
  const directory = path.join(root, key)
  fs.mkdirSync(directory, { recursive: true })
  app.setPath(key, directory)
}
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-extensions')
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  originalHandle(
    channel,
    /^app:(install-|import-managed-python)/.test(channel)
      ? async () => {
          throw new Error('Quality fixture does not install optional environments')
        }
      : listener
  )
const local = (value) => {
  try {
    const url = new URL(value)
    return (
      ['file:', 'devtools:', 'data:', 'blob:'].includes(url.protocol) ||
      (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
  } catch {
    return false
  }
}
// Chromium/main fetch are blocked before loading product code. This is not an OS sandbox.
const originalFetch = global.fetch
global.fetch = (input, init) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
  if (!local(url)) return Promise.reject(new Error('Quality isolation rejected an external fetch'))
  return originalFetch(input, init)
}
void app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !local(details.url) }))
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
})
require(path.join(project, 'out/main/index.js'))
