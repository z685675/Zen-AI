import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/i18n', () => ({
  default: {
    t: vi.fn((key: string) => {
      if (key === 'message.download.failed') return 'Download failed'
      return key
    })
  }
}))

import { download } from '../download'

describe('download', () => {
  const createElement = vi.fn()
  const appendChild = vi.fn()
  const click = vi.fn()
  const remove = vi.fn()
  const createObjectURL = vi.fn(() => 'blob:generated')
  const revokeObjectURL = vi.fn()
  const fetchMock = vi.fn()
  const toastError = vi.fn()

  const waitForAsync = () => new Promise((resolve) => setTimeout(resolve, 0))

  beforeEach(() => {
    vi.clearAllMocks()

    Object.defineProperty(window, 'toast', {
      value: { error: toastError },
      writable: true
    })

    createElement.mockReturnValue({
      href: '',
      download: '',
      click,
      remove
    })

    Object.defineProperty(document, 'createElement', { value: createElement, writable: true })
    Object.defineProperty(document.body, 'appendChild', { value: appendChild, writable: true })
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true })

    global.fetch = fetchMock as any
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('downloads supported direct URLs without fetch', () => {
    download('file:///Users/test/report.pdf')

    const link = createElement.mock.results[0].value
    expect(link.href).toBe('file:///Users/test/report.pdf')
    expect(link.download).toBe('report.pdf')
    expect(click).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('generates a timestamped filename for supported data URLs', () => {
    vi.spyOn(Date, 'now').mockReturnValue(12345)

    download('data:image/png;base64,xxx')

    const link = createElement.mock.results[0].value
    expect(link.download).toBe('12345_download.png')
  })

  it('downloads fetched blobs and applies a timestamped filename', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(67890)
    fetchMock.mockResolvedValue({
      headers: new Headers(),
      blob: () => Promise.resolve(new Blob(['test']))
    })

    download('https://example.com/file.pdf')
    await waitForAsync()

    const link = createElement.mock.results.at(-1)?.value
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/file.pdf')
    expect(createObjectURL).toHaveBeenCalled()
    expect(link.download).toBe('67890_file.pdf')
  })

  it('shows a user-friendly error when fetch fails', async () => {
    fetchMock.mockRejectedValue(new Error('Network error'))

    download('https://example.com/file.pdf')
    await waitForAsync()

    expect(toastError).toHaveBeenCalledWith('Download failed: Network error')
  })
})
