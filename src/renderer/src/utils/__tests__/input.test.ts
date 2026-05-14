import type { SendMessageShortcut } from '@renderer/store/settings'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getFilesFromDropEvent, getSendMessageShortcutLabel, isSendMessageKeyPressed } from '../input'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn()
    })
  }
}))

vi.mock('@renderer/config/constant', () => ({
  isMac: false,
  isWin: true
}))

describe('input utils', () => {
  const mockGetPathForFile = vi.fn()
  const mockFileGet = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    ;(window as any).api = {
      file: {
        getPathForFile: mockGetPathForFile,
        get: mockFileGet
      }
    }
  })

  it('reads dropped File objects through getPathForFile', async () => {
    const file1 = new File(['a'], 'a.txt')
    const file2 = new File(['b'], 'b.txt')
    mockGetPathForFile.mockImplementation((file: File) => (file === file1 ? '/tmp/a.txt' : '/tmp/b.txt'))
    mockFileGet.mockImplementation((path: string) => ({ path, name: path.split('/').pop() }))

    const result = await getFilesFromDropEvent({
      dataTransfer: {
        files: [file1, file2],
        items: []
      }
    } as any)

    expect(result).toEqual([
      { path: '/tmp/a.txt', name: 'a.txt' },
      { path: '/tmp/b.txt', name: 'b.txt' }
    ])
  })

  it('reads custom codefiles drops', async () => {
    mockFileGet.mockResolvedValue({ path: '/tmp/a.txt', name: 'a.txt' })

    const result = await getFilesFromDropEvent({
      dataTransfer: {
        files: [],
        items: [
          {
            type: 'codefiles',
            getAsString: (cb: (value: string) => void) => cb(JSON.stringify(['/tmp/a.txt']))
          }
        ]
      }
    } as any)

    expect(result).toEqual([{ path: '/tmp/a.txt', name: 'a.txt' }])
  })

  it('returns shortcut labels for configured send actions', () => {
    expect(getSendMessageShortcutLabel('Enter')).toBe('Enter')
    expect(getSendMessageShortcutLabel('Ctrl+Enter')).toBe('Ctrl + Enter')
    expect(getSendMessageShortcutLabel('Command+Enter')).toBe('Win + Enter')
    expect(getSendMessageShortcutLabel('Custom+Enter' as SendMessageShortcut)).toBe('Custom+Enter')
  })

  it('checks exact modifier combinations for send shortcuts', () => {
    expect(
      isSendMessageKeyPressed(
        { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false } as any,
        'Enter'
      )
    ).toBe(true)
    expect(
      isSendMessageKeyPressed(
        { shiftKey: false, ctrlKey: true, metaKey: false, altKey: false } as any,
        'Ctrl+Enter'
      )
    ).toBe(true)
    expect(
      isSendMessageKeyPressed(
        { shiftKey: false, ctrlKey: false, metaKey: true, altKey: false } as any,
        'Command+Enter'
      )
    ).toBe(true)
    expect(
      isSendMessageKeyPressed(
        { shiftKey: true, ctrlKey: true, metaKey: false, altKey: false } as any,
        'Ctrl+Enter'
      )
    ).toBe(false)
  })
})
