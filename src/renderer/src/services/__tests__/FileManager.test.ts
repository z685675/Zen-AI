import type { FileMetadata } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import FileManager from '../FileManager'

vi.mock('@renderer/databases', () => ({
  default: {
    files: {
      get: vi.fn(),
      update: vi.fn(),
      add: vi.fn(),
      delete: vi.fn(),
      toArray: vi.fn()
    }
  }
}))

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      runtime: {
        filesPath: 'C:/Users/test/AppData/Roaming/zen-ai/DataFiles'
      }
    })
  }
}))

vi.mock('@renderer/i18n', () => ({
  default: {
    t: (key: string) => key
  }
}))

vi.mock('@renderer/utils', () => ({
  getFileDirectory: (filePath: string) => filePath
}))

const createFile = (overrides: Partial<FileMetadata> = {}): FileMetadata =>
  ({
    id: 'eaddc209-f0bd-4c0d-9592-eb120b814395',
    name: 'eaddc209-f0bd-4c0d-9592-eb120b814395.png',
    origin_name: 'generated.png',
    path: 'C:/Users/test/AppData/Roaming/zen-ai/DataFiles/eaddc209-f0bd-4c0d-9592-eb120b814395.png',
    size: 10,
    ext: 'png',
    type: 'image',
    created_at: '2026-05-31T00:00:00.000Z',
    count: 1,
    ...overrides
  }) as FileMetadata

describe('FileManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.api = {
      file: {
        binaryImage: vi.fn().mockResolvedValue({ data: new Uint8Array([1, 2, 3]), mime: 'image/png' }),
        base64File: vi.fn().mockResolvedValue({ data: 'abc', mime: 'image/png' }),
        delete: vi.fn().mockResolvedValue(undefined)
      }
    } as any
  })

  it('uses the persisted storage filename instead of concatenating id and extension', async () => {
    const file = createFile()

    await FileManager.readBinaryImage(file)

    expect(window.api.file.binaryImage).toHaveBeenCalledWith('eaddc209-f0bd-4c0d-9592-eb120b814395.png')
  })

  it('falls back to id plus normalized extension for legacy records without name', () => {
    const file = createFile({ name: '', ext: 'jpg' })

    expect(FileManager.getStorageFileName(file)).toBe('eaddc209-f0bd-4c0d-9592-eb120b814395.jpg')
  })
})
