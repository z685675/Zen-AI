import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { preprocessOcrImage } from '../ocr'

describe('OCR image preprocessing', () => {
  it('uses auto-oriented dimensions when upscaling phone images', async () => {
    const source = await sharp({
      create: { width: 120, height: 240, channels: 3, background: '#ffffff' }
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()

    const output = await preprocessOcrImage(source)
    const metadata = await sharp(output).metadata()

    expect(metadata.width).toBe(480)
    expect(metadata.height).toBe(240)
  })

  it('supports a high-contrast retry without changing image dimensions', async () => {
    const source = await sharp({
      create: { width: 900, height: 450, channels: 3, background: '#555555' }
    })
      .composite([
        {
          input: { create: { width: 450, height: 450, channels: 3, background: '#eeeeee' } },
          left: 450,
          top: 0
        }
      ])
      .png()
      .toBuffer()

    const output = await preprocessOcrImage(source, 'high-contrast')
    const metadata = await sharp(output).metadata()
    const stats = await sharp(output).stats()

    expect(metadata.width).toBe(1600)
    expect(metadata.height).toBe(800)
    expect(stats.channels.every((channel) => channel.min === 0 && channel.max === 255)).toBe(true)
  })

  it('rejects images above the decoded pixel safety limit', async () => {
    const oversizedSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="6000"></svg>')

    await expect(preprocessOcrImage(oversizedSvg)).rejects.toThrow()
  })
})
