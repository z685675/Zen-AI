import type { Transaction } from 'dexie'
import { describe, expect, it, vi } from 'vitest'

import { migrateRestoredInternalPaths, upgradeToV13 } from './upgrades'

describe('Dexie v13 restored paths', () => {
  it('relocates stored attachments without changing conversation text or arbitrary tool data', async () => {
    const destination = '/Users/new/Library/Application Support/zen-ai'
    const oldPath = 'C:\\Users\\old\\AppData\\Roaming\\zen-ai\\Data\\Files\\attachment.png'
    const migratedPath = destination + '/Data/Files/attachment.png'
    const oldUrl = 'file:///C:/Users/old/AppData/Roaming/zen-ai/Data/Files/attachment.png'
    const migratedUrl = 'file:///Users/new/Library/Application%20Support/zen-ai/Data/Files/attachment.png'
    const prose = 'Here is an example path: ' + oldPath
    const toolData = { path: oldPath }

    const files = [{ path: oldPath }]
    const blocks = [
      { type: 'main_text', content: prose },
      { type: 'tool', arguments: toolData },
      { type: 'file', file: { path: oldPath } },
      {
        type: 'image',
        url: oldUrl,
        file: { path: oldPath },
        metadata: { prompt: prose, generateImageResponse: { type: 'url', images: [oldUrl] } }
      },
      { type: 'video', filePath: oldPath, url: oldUrl }
    ]
    const topics = [{ messages: [{ content: prose, files: [{ path: oldPath }], images: [oldUrl] }] }]
    const tables = { files, message_blocks: blocks, topics }
    const updated: unknown[] = []
    let savedProfile: { id: string; value: string } | undefined = {
      id: 'internalDataPathProfile',
      value: 'C:\\Users\\old\\AppData\\Roaming\\zen-ai'
    }
    const table = (name: keyof typeof tables | 'settings') => {
      if (name === 'settings')
        return {
          get: async () => savedProfile,
          put: async (profile: NonNullable<typeof savedProfile>) => {
            savedProfile = profile
          }
        }
      return {
        toCollection: () => ({
          modify: async (rewrite: (record: unknown) => boolean) => {
            for (const record of tables[name]) {
              if (rewrite(record)) updated.push(record)
            }
          }
        })
      }
    }
    const tx = { table } as unknown as Transaction
    const appInfo = await window.api.getAppInfo()
    vi.mocked(window.api.getAppInfo).mockResolvedValueOnce({ ...appInfo, appDataPath: destination })
    await upgradeToV13(tx)

    expect(files).toEqual([{ path: migratedPath }])
    expect(blocks).toEqual([
      { type: 'main_text', content: prose },
      { type: 'tool', arguments: { path: oldPath } },
      { type: 'file', file: { path: migratedPath } },
      {
        type: 'image',
        url: migratedUrl,
        file: { path: migratedPath },
        metadata: { prompt: prose, generateImageResponse: { type: 'url', images: [migratedUrl] } }
      },
      { type: 'video', filePath: migratedPath, url: migratedUrl }
    ])
    expect(topics).toEqual([{ messages: [{ content: prose, files: [{ path: migratedPath }], images: [migratedUrl] }] }])
    expect(updated).toHaveLength(5)
    expect(savedProfile?.value).toBe(destination)

    // Switching profiles is also handled on reopen, without a version change.
    const anotherDestination = 'D:/profile/zen-ai'
    updated.length = 0
    await migrateRestoredInternalPaths(tx, anotherDestination)
    expect(files).toEqual([{ path: anotherDestination + '/Data/Files/attachment.png' }])
    expect(savedProfile?.value).toBe(anotherDestination)
    expect(updated).toHaveLength(5)

    updated.length = 0
    await migrateRestoredInternalPaths(tx, anotherDestination)
    expect(updated).toHaveLength(0)
  })
})
