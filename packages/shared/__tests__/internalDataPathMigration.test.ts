import { describe, expect, it } from 'vitest'

import { migrateInternalDataPathsDeep, migrateInternalDataPathsInString } from '../utils/internalDataPathMigration'

const currentUserData = 'C:\\Users\\admin\\AppData\\Roaming\\zen-ai'

describe('internal data path migration', () => {
  it('migrates Windows internal Data paths', () => {
    const result = migrateInternalDataPathsInString(
      'C:\\Users\\zen_z\\AppData\\Roaming\\zen-ai\\Data\\Agents\\n-default',
      currentUserData
    )

    expect(result.changed).toBe(true)
    expect(result.value).toBe('C:\\Users\\admin\\AppData\\Roaming\\zen-ai\\Data\\Agents\\n-default')
  })

  it('migrates escaped JSON path strings', () => {
    const result = migrateInternalDataPathsInString(
      '["C:\\\\Users\\\\zen_z\\\\AppData\\\\Roaming\\\\zen-ai\\\\Data\\\\Agents\\\\n-default"]',
      currentUserData
    )

    expect(result.changed).toBe(true)
    expect(result.value).toBe('["C:\\\\Users\\\\admin\\\\AppData\\\\Roaming\\\\zen-ai\\\\Data\\\\Agents\\\\n-default"]')
  })

  it('migrates file URLs while preserving the URL prefix', () => {
    const result = migrateInternalDataPathsInString(
      'file://C:\\Users\\zen\\AppData\\Roaming\\zen-ai\\Data\\Files\\image.png',
      currentUserData
    )

    expect(result.changed).toBe(true)
    expect(result.value).toBe('file://C:\\Users\\admin\\AppData\\Roaming\\zen-ai\\Data\\Files\\image.png')
  })

  it('does not migrate external user file paths', () => {
    const externalPath = 'C:\\Users\\zen\\Documents\\wechat\\xwechat_files\\image.jpg'
    const result = migrateInternalDataPathsInString(externalPath, currentUserData)

    expect(result.changed).toBe(false)
    expect(result.value).toBe(externalPath)
  })

  it('quickly skips large text without an internal app data path candidate', () => {
    const largeContent = `${'large message Data '.repeat(100_000)}C:\\Users\\zen\\Documents\\wechat\\image.jpg`
    const result = migrateInternalDataPathsInString(largeContent, currentUserData)

    expect(result.changed).toBe(false)
    expect(result.value).toBe(largeContent)
  })

  it('migrates nested objects', () => {
    const result = migrateInternalDataPathsDeep(
      {
        file: {
          path: 'C:/Users/zen_z/AppData/Roaming/zen-ai/Data/Files/a.png'
        }
      },
      currentUserData
    )

    expect(result.changed).toBe(true)
    expect(result.value.file.path).toBe('C:/Users/admin/AppData/Roaming/zen-ai/Data/Files/a.png')
  })

  it('preserves non-plain objects while migrating surrounding paths', () => {
    const createdAt = new Date('2026-06-19T00:00:00.000Z')
    const result = migrateInternalDataPathsDeep(
      {
        createdAt,
        file: {
          path: 'C:/Users/zen_z/AppData/Roaming/zen-ai/Data/Files/a.png'
        }
      },
      currentUserData
    )

    expect(result.changed).toBe(true)
    expect(result.value.createdAt).toBe(createdAt)
    expect(result.value.file.path).toBe('C:/Users/admin/AppData/Roaming/zen-ai/Data/Files/a.png')
  })

  it('migrates POSIX internal Data paths', () => {
    const result = migrateInternalDataPathsInString(
      'file:///Users/old/Library/Application Support/zen-ai/Data/Files/a.png',
      '/Users/new/Library/Application Support/zen-ai'
    )

    expect(result.changed).toBe(true)
    expect(result.value).toBe('file:///Users/new/Library/Application Support/zen-ai/Data/Files/a.png')
  })

  it('migrates dev app data directory paths', () => {
    const result = migrateInternalDataPathsInString(
      'C:\\Users\\zen_z\\AppData\\Roaming\\ZenAIDev\\Data\\Agents\\n-default',
      currentUserData
    )

    expect(result.changed).toBe(true)
    expect(result.value).toBe('C:\\Users\\admin\\AppData\\Roaming\\zen-ai\\Data\\Agents\\n-default')
  })

  it('does not reprocess the middle of migrated Windows slash paths', () => {
    const result = migrateInternalDataPathsInString(
      'C:/Users/old/AppData/Roaming/zen-ai/Data/Files/a.png',
      'C:/Users/admin/AppData/Roaming/zen-ai'
    )

    expect(result.changed).toBe(true)
    expect(result.value).toBe('C:/Users/admin/AppData/Roaming/zen-ai/Data/Files/a.png')
  })
})
