import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadOcrImage: vi.fn(),
  recognize: vi.fn()
}))

vi.mock('@main/constant', () => ({ isLinux: false, isWin: false }))
vi.mock('@main/utils/ocr', () => ({ loadOcrImage: mocks.loadOcrImage }))
vi.mock('@napi-rs/system-ocr', () => ({
  OcrAccuracy: { Accurate: 1 },
  recognize: mocks.recognize
}))

import { SystemOcrService } from '../SystemOcrService'

describe('SystemOcrService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadOcrImage.mockResolvedValue(Buffer.from('processed-image'))
  })

  it('normalizes fractional macOS confidence to the shared 0-100 scale', async () => {
    mocks.recognize.mockResolvedValue({ text: 'Readable OCR result', confidence: 0.91 })
    const service = new SystemOcrService()

    const result = await service.ocr(
      {
        id: 'image',
        name: 'package.json',
        origin_name: 'package.json',
        path: `${process.cwd()}\\package.json`,
        size: 1,
        ext: '.png',
        type: 'image',
        created_at: new Date(0).toISOString(),
        count: 1
      },
      { preprocess: 'auto' }
    )

    expect(mocks.loadOcrImage).toHaveBeenCalledWith(expect.any(Object), 'auto')
    expect(result).toEqual({ text: 'Readable OCR result', confidence: 91 })
  })
})
