import { exec, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { loggerService } from '@logger'
import { APP_NAME, APP_PROTOCOL } from '@shared/config/constant'
import { app } from 'electron'

import { handleProvidersProtocolUrl } from './urlschema/handle-providers'
import { handleMcpProtocolUrl } from './urlschema/mcp-install'
import { windowService } from './WindowService'

const logger = loggerService.withContext('ProtocolClient')

export const CHERRY_STUDIO_PROTOCOL = APP_PROTOCOL

export function registerProtocolClient(app: Electron.App) {
  let registered = false

  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      registered = app.setAsDefaultProtocolClient(CHERRY_STUDIO_PROTOCOL, process.execPath, [process.argv[1]])
    }
  } else {
    registered = app.setAsDefaultProtocolClient(CHERRY_STUDIO_PROTOCOL)
  }

  if (!process.defaultApp) {
    logger.info('Protocol registration attempted', {
      protocol: CHERRY_STUDIO_PROTOCOL,
      registered,
      exePath: app.getPath('exe')
    })
  }

  if (process.platform === 'win32' && !process.defaultApp) {
    try {
      registerProtocolClientWindowsFallback(app)
      logger.info('Protocol registration synchronized via Windows registry fallback', {
        protocol: CHERRY_STUDIO_PROTOCOL,
        electronRegistered: registered,
        exePath: app.getPath('exe')
      })
    } catch (error) {
      logger.error('Failed to register protocol via Windows registry fallback', error as Error)
    }
  }
}

export function handleProtocolUrl(url: string) {
  if (!url) return
  // Process the URL that was used to open the app
  // The url will be in the format: zenai://data?param1=value1&param2=value2

  // Parse the URL and extract parameters
  const urlObj = new URL(url)
  const params = new URLSearchParams(urlObj.search)

  switch (urlObj.hostname.toLowerCase()) {
    case 'mcp':
      handleMcpProtocolUrl(urlObj)
      return
    case 'providers':
      void handleProvidersProtocolUrl(urlObj)
      return
  }

  // You can send the data to your renderer process
  const mainWindow = windowService.getMainWindow()

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('protocol-data', {
      url,
      params: Object.fromEntries(params.entries())
    })
  }
}

const execAsync = promisify(exec)

const DESKTOP_FILE_NAME = 'zen-ai-url-handler.desktop'

/**
 * Sets up deep linking for the AppImage build on Linux by creating a .desktop file.
 * This allows the OS to open the app protocol with this app.
 */
export async function setupAppImageDeepLink(): Promise<void> {
  // Only run on Linux and when packaged as an AppImage
  if (process.platform !== 'linux' || !process.env.APPIMAGE) {
    return
  }

  logger.debug('AppImage environment detected on Linux, setting up deep link.')

  try {
    const appPath = app.getPath('exe')
    if (!appPath) {
      logger.error('Could not determine App path.')
      return
    }

    const homeDir = app.getPath('home')
    const applicationsDir = path.join(homeDir, '.local', 'share', 'applications')
    const desktopFilePath = path.join(applicationsDir, DESKTOP_FILE_NAME)

    // Ensure the applications directory exists
    await fs.mkdir(applicationsDir, { recursive: true })

    // Content of the .desktop file
    // %U allows passing the URL to the application
    // NoDisplay=true hides it from the regular application menu
    const desktopFileContent = `[Desktop Entry]
Name=${APP_NAME}
Exec=${escapePathForExec(appPath)} %U
Terminal=false
Type=Application
MimeType=x-scheme-handler/${CHERRY_STUDIO_PROTOCOL};
NoDisplay=true
`

    // Write the .desktop file (overwrite if exists)
    await fs.writeFile(desktopFilePath, desktopFileContent, 'utf-8')
    logger.debug(`Created/Updated desktop file: ${desktopFilePath}`)

    // Update the desktop database
    // It's important to update the database for the changes to take effect
    try {
      const { stdout, stderr } = await execAsync(`update-desktop-database ${escapePathForExec(applicationsDir)}`)
      if (stderr) {
        logger.warn(`update-desktop-database stderr: ${stderr}`)
      }
      logger.debug(`update-desktop-database stdout: ${stdout}`)
      logger.debug('Desktop database updated successfully.')
    } catch (updateError) {
      logger.error('Failed to update desktop database:', updateError as Error)
      // Continue even if update fails, as the file is still created.
    }
  } catch (error) {
    // Log the error but don't prevent the app from starting
    logger.error('Failed to setup AppImage deep link:', error as Error)
  }
}

/**
 * Escapes a path for safe use within the Exec field of a .desktop file
 * and for shell commands. Handles spaces and potentially other special characters
 * by quoting.
 */
function escapePathForExec(filePath: string): string {
  // Simple quoting for paths with spaces.
  return `'${filePath.replace(/'/g, "'\\''")}'`
}

function registerProtocolClientWindowsFallback(app: Electron.App) {
  const exePath = app.getPath('exe')
  const protocolKey = `HKCU\\Software\\Classes\\${CHERRY_STUDIO_PROTOCOL}`
  const commandKey = `${protocolKey}\\shell\\open\\command`
  const iconKey = `${protocolKey}\\DefaultIcon`
  const commandValue = `"${exePath}" "%1"`

  execFileSync('reg', ['add', protocolKey, '/ve', '/d', `URL:${APP_NAME} Protocol`, '/f'], { stdio: 'ignore' })
  execFileSync('reg', ['add', protocolKey, '/v', 'URL Protocol', '/d', '', '/f'], { stdio: 'ignore' })
  execFileSync('reg', ['add', iconKey, '/ve', '/d', `"${exePath}",0`, '/f'], { stdio: 'ignore' })
  execFileSync('reg', ['add', commandKey, '/ve', '/d', commandValue, '/f'], { stdio: 'ignore' })
}
