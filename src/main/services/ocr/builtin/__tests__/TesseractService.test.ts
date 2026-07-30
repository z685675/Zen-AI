import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  loadOcrImage: vi.fn(),
  recognize: vi.fn(),
  setParameters: vi.fn(),
  terminate: vi.fn()
}))

vi.unmock('node:fs')
vi.unmock('node:path')
vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.TEMP || process.cwd()
  }
}))
vi.mock('tesseract.js', () => ({
  createWorker: mocks.createWorker,
  PSM: { AUTO: '3' }
}))
vi.mock('@main/utils/ipService', () => ({
  getIpCountry: vi.fn(async () => 'US')
}))
vi.mock('@main/utils/ocr', () => ({
  loadOcrImage: mocks.loadOcrImage
}))

import { TesseractService } from '../TesseractService'

describe('TesseractService worker reuse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadOcrImage.mockResolvedValue(Buffer.from('processed-image'))
    mocks.createWorker.mockImplementation(async () => ({
      recognize: mocks.recognize,
      setParameters: mocks.setParameters,
      terminate: mocks.terminate
    }))
  })

  it('reuses one worker while the requested language set is unchanged', async () => {
    const service = new TesseractService()
    const config = { langs: { chi_sim: true, eng: true } } as const

    const first = await service.getWorker(config)
    const second = await service.getWorker(config)

    expect(second).toBe(first)
    expect(mocks.createWorker).toHaveBeenCalledTimes(1)
    expect(mocks.terminate).not.toHaveBeenCalled()
  })

  it('recreates the worker when languages change', async () => {
    const service = new TesseractService()

    await service.getWorker({ langs: { eng: true } })
    await service.getWorker({ langs: { chi_sim: true, eng: true } })

    expect(mocks.createWorker).toHaveBeenCalledTimes(2)
    expect(mocks.terminate).toHaveBeenCalledTimes(1)
  })

  it('returns confidence and paragraph-aware lines from Tesseract', async () => {
    mocks.recognize.mockResolvedValue({
      data: {
        text: 'First line\nSecond line\n\nNew paragraph',
        confidence: 87,
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  { text: 'First line\n', confidence: 91, bbox: { x0: 1, y0: 2, x1: 30, y1: 12 } },
                  { text: 'Second line\n', confidence: 88, bbox: { x0: 1, y0: 14, x1: 35, y1: 24 } }
                ]
              },
              {
                lines: [{ text: 'New paragraph\n', confidence: 83, bbox: { x0: 1, y0: 30, x1: 45, y1: 40 } }]
              }
            ]
          }
        ]
      }
    })
    const service = new TesseractService()

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
      { langs: { chi_sim: true, eng: true }, preprocess: 'high-contrast' }
    )

    expect(mocks.loadOcrImage).toHaveBeenCalledWith(expect.any(Object), 'high-contrast')
    expect(mocks.setParameters).toHaveBeenCalledWith({
      tessedit_pageseg_mode: '3',
      preserve_interword_spaces: '1',
      user_defined_dpi: '300'
    })
    expect(mocks.recognize).toHaveBeenCalledWith(
      Buffer.from('processed-image'),
      { rotateAuto: true },
      { blocks: true, text: true }
    )
    expect(result).toEqual({
      text: 'First line\nSecond line\n\nNew paragraph',
      confidence: 87,
      lines: [
        {
          text: 'First line',
          confidence: 91,
          bbox: { x0: 1, y0: 2, x1: 30, y1: 12 },
          paragraph: 0
        },
        {
          text: 'Second line',
          confidence: 88,
          bbox: { x0: 1, y0: 14, x1: 35, y1: 24 },
          paragraph: 0
        },
        {
          text: 'New paragraph',
          confidence: 83,
          bbox: { x0: 1, y0: 30, x1: 45, y1: 40 },
          paragraph: 1
        }
      ]
    })
  })
})
