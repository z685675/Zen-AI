import { describe, expect, it } from 'vitest'

import { compress, decompress } from '../zip'

const jsonStr = JSON.stringify({ foo: 'bar', num: 42, arr: [1, 2, 3] })

function makeLargeString(size: number) {
  return 'a'.repeat(size)
}

describe('zip', () => {
  describe('compress & decompress', () => {
    it('compresses and decompresses a normal JSON string', async () => {
      const compressed = await compress(jsonStr)
      expect(compressed).toBeInstanceOf(Buffer)

      const decompressed = await decompress(compressed)
      expect(decompressed).toBe(jsonStr)
    })

    it('handles empty string', async () => {
      const compressed = await compress('')
      expect(compressed).toBeInstanceOf(Buffer)

      const decompressed = await decompress(compressed)
      expect(decompressed).toBe('')
    })

    it('handles large string', async () => {
      const largeStr = makeLargeString(100_000)
      const compressed = await compress(largeStr)
      expect(compressed).toBeInstanceOf(Buffer)
      expect(compressed.length).toBeLessThan(largeStr.length)

      const decompressed = await decompress(compressed)
      expect(decompressed).toBe(largeStr)
    })

    it('throws when decompressing invalid data', async () => {
      await expect(decompress(Buffer.from('not a valid gzip', 'utf-8'))).rejects.toThrow()
    })

    it('throws for invalid compress input', async () => {
      await expect(compress(null as unknown as string)).rejects.toThrow()
      await expect(compress(undefined as unknown as string)).rejects.toThrow()
      await expect(compress(123 as unknown as string)).rejects.toThrow()
    })

    it('throws for invalid decompress input', async () => {
      await expect(decompress(null as unknown as Buffer)).rejects.toThrow()
      await expect(decompress(undefined as unknown as Buffer)).rejects.toThrow()
      await expect(decompress('string' as unknown as Buffer)).rejects.toThrow()
    })
  })
})
