import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { loggerService } from '@logger'
import { isMac } from '@main/constant'

import { windowService } from '../WindowService'

const logger = loggerService.withContext('ProviderImport')

export const ZENAI_PROVIDER_IMPORT_EXTENSION = '.zenai-provider.json'

export type ProviderImportPayload = {
  id: string
  apiKey: string
  baseUrl: string
  type?: string
  name?: string
  source?: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isProviderImportPayload(value: unknown): value is ProviderImportPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const payload = value as Record<string, unknown>
  return isNonEmptyString(payload.id) && isNonEmptyString(payload.apiKey) && isNonEmptyString(payload.baseUrl)
}

export function normalizeProviderImportPayload(payload: ProviderImportPayload): ProviderImportPayload {
  return {
    id: payload.id.trim(),
    apiKey: payload.apiKey.trim(),
    baseUrl: payload.baseUrl.trim(),
    type: payload.type?.trim(),
    name: payload.name?.trim(),
    source: payload.source?.trim()
  }
}

export function isProviderImportFilePath(filePath: string | undefined | null): filePath is string {
  if (!filePath) {
    return false
  }

  return filePath.toLowerCase().endsWith(ZENAI_PROVIDER_IMPORT_EXTENSION)
}

export async function navigateToProviderImport(payload: ProviderImportPayload): Promise<void> {
  const mainWindow = windowService.getMainWindow()
  const normalizedPayload = normalizeProviderImportPayload(payload)
  const encodedData = encodeURIComponent(JSON.stringify(normalizedPayload))
  const targetPath = `/settings/provider?addProviderData=${encodedData}`

  if (!mainWindow || mainWindow.isDestroyed()) {
    logger.warn('Main window not available for provider import, retrying in 1s')
    setTimeout(() => {
      void navigateToProviderImport(normalizedPayload)
    }, 1000)
    return
  }

  try {
    const hasNavigate = await mainWindow.webContents.executeJavaScript(`typeof window.navigate === 'function'`)
    if (!hasNavigate) {
      logger.warn('window.navigate not available yet for provider import, retrying in 1s')
      setTimeout(() => {
        void navigateToProviderImport(normalizedPayload)
      }, 1000)
      return
    }

    await mainWindow.webContents.executeJavaScript(`window.navigate(${JSON.stringify(targetPath)})`)
    if (isMac) {
      windowService.showMainWindow()
    }
  } catch (error) {
    logger.error('Failed to navigate to provider import', error as Error)
  }
}

export async function importProviderFromFile(filePath: string): Promise<void> {
  if (!isProviderImportFilePath(filePath)) {
    logger.warn('Skipped unsupported provider import file', { filePath })
    return
  }

  try {
    const rawContent = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(rawContent) as unknown
    if (!isProviderImportPayload(parsed)) {
      logger.error('Invalid provider import payload', { filePath, fileName: basename(filePath) })
      return
    }

    await navigateToProviderImport(parsed)
  } catch (error) {
    logger.error('Failed to import provider from file', error as Error, {
      filePath,
      fileName: basename(filePath)
    })
  }
}
