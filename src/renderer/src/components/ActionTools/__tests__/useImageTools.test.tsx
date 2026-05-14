import { useImageTools } from '@renderer/components/ActionTools'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  svgToPngBlob: vi.fn(),
  svgToSvgBlob: vi.fn(),
  download: vi.fn(),
  previewShow: vi.fn()
}))

vi.mock('@renderer/utils/image', () => ({
  svgToPngBlob: mocks.svgToPngBlob,
  svgToSvgBlob: mocks.svgToSvgBlob
}))

vi.mock('@renderer/utils/download', () => ({
  download: mocks.download
}))

vi.mock('@renderer/services/ImagePreviewService', () => ({
  ImagePreviewService: {
    show: mocks.previewShow
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({
    theme: 'light'
  })
}))

const mockWrite = vi.fn()
const mockToast = {
  success: vi.fn(),
  error: vi.fn()
}
const mockCreateObjectURL = vi.fn(() => 'blob:test-url')
const mockRevokeObjectURL = vi.fn()

class MockClipboardItem {
  constructor(items: any) {
    return items
  }
}

const createContainer = () =>
  ({
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    contains: vi.fn().mockReturnValue(true),
    style: { cursor: '' },
    querySelector: vi.fn(),
    shadowRoot: null
  }) as unknown as HTMLDivElement

const createSvg = () =>
  ({
    style: {
      transform: '',
      transformOrigin: ''
    },
    cloneNode: vi.fn().mockReturnThis()
  }) as unknown as SVGElement

describe('useImageTools', () => {
  beforeEach(() => {
    Object.defineProperty(global.navigator, 'clipboard', {
      value: { write: mockWrite },
      writable: true
    })

    Object.defineProperty(global.window, 'toast', {
      value: mockToast,
      writable: true
    })

    global.ClipboardItem = MockClipboardItem as any
    global.URL = {
      createObjectURL: mockCreateObjectURL,
      revokeObjectURL: mockRevokeObjectURL
    } as any

    global.DOMMatrix = class DOMMatrix {
      m41 = 0
      m42 = 0
      a = 1
      d = 1
    } as any

    vi.clearAllMocks()
  })

  it('supports pan and zoom updates', () => {
    const container = createContainer()
    const svg = createSvg()
    container.querySelector = vi.fn().mockReturnValue(svg)

    const { result } = renderHook(() =>
      useImageTools(
        { current: container },
        {
          prefix: 'test',
          imgSelector: 'svg'
        }
      )
    )

    act(() => {
      result.current.pan(10, 20)
      result.current.zoom(0.5)
    })

    expect(result.current.getCurrentTransform().x).toBe(10)
    expect(result.current.getCurrentTransform().y).toBe(20)
    expect(result.current.getCurrentTransform().scale).toBe(1.5)
    expect(svg.style.transform).toContain('translate(10px, 20px)')
    expect(svg.style.transform).toContain('scale(1.5)')
  })

  it('copies images and downloads PNG/SVG variants', async () => {
    const container = createContainer()
    const svg = createSvg()
    container.querySelector = vi.fn().mockReturnValue(svg)
    const pngBlob = new Blob(['png'], { type: 'image/png' })
    const svgBlob = new Blob(['svg'], { type: 'image/svg+xml' })
    mocks.svgToPngBlob.mockResolvedValue(pngBlob)
    mocks.svgToSvgBlob.mockReturnValue(svgBlob)

    const { result } = renderHook(() =>
      useImageTools(
        { current: container },
        {
          prefix: 'test',
          imgSelector: 'svg'
        }
      )
    )

    await act(async () => {
      await result.current.copy()
      await result.current.download('png')
      await result.current.download('svg')
    })

    expect(mocks.svgToPngBlob).toHaveBeenCalledWith(svg)
    expect(mocks.svgToSvgBlob).toHaveBeenCalledWith(svg)
    expect(mockWrite).toHaveBeenCalled()
    expect(mockToast.success).toHaveBeenCalledWith('message.copy.success')
    expect(mocks.download).toHaveBeenCalledTimes(2)
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(2)
    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('handles missing elements and conversion failures gracefully', async () => {
    const container = createContainer()
    container.querySelector = vi.fn().mockReturnValue(null)

    const { result, rerender } = renderHook(
      ({ current }) =>
        useImageTools(
          { current },
          {
            prefix: 'test',
            imgSelector: 'svg'
          }
        ),
      { initialProps: { current: container } }
    )

    await act(async () => {
      await result.current.copy()
      await result.current.download('png')
      await result.current.dialog()
    })

    expect(mocks.svgToPngBlob).not.toHaveBeenCalled()
    expect(mocks.previewShow).not.toHaveBeenCalled()

    const svg = createSvg()
    container.querySelector = vi.fn().mockReturnValue(svg)
    mocks.svgToPngBlob.mockRejectedValue(new Error('Conversion failed'))
    mocks.previewShow.mockRejectedValue(new Error('Preview failed'))

    rerender({ current: container })

    await act(async () => {
      await result.current.copy()
      await result.current.download('png')
      await result.current.dialog()
    })

    expect(mockToast.error).toHaveBeenCalledWith('message.copy.failed')
    expect(mockToast.error).toHaveBeenCalledWith('message.download.failed')
    expect(mockToast.error).toHaveBeenCalledWith('message.dialog.failed')
  })
})
