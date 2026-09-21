import { describe, expect, it, vi } from 'vitest'

import {
  buildGrokImagineImageRequestBody,
  composeImageEditPrompt,
  extractImageGenerationSources,
  fetchImageGenerationRequest,
  isSupportedImageFile,
  resolvePaintingBasePrompt,
  validateImageInputFiles
} from '../imageGenerationUtils'

describe('imageGenerationUtils', () => {
  it('builds the native Grok Imagine generation request', () => {
    expect(
      buildGrokImagineImageRequestBody({
        model: 'grok-imagine-image-2.0',
        prompt: 'A red fox in a snowy forest',
        n: 2,
        aspectRatio: '16:9',
        resolution: '2k',
        quality: 'medium'
      })
    ).toEqual({
      model: 'grok-imagine-image-2.0',
      prompt: 'A red fox in a snowy forest',
      n: 2,
      resolution: '2k',
      response_format: 'url',
      aspect_ratio: '16:9',
      quality: 'medium'
    })
  })

  it('omits the automatic Grok quality because it is the upstream default', () => {
    const body = buildGrokImagineImageRequestBody({
      model: 'grok-imagine-image-2.0',
      prompt: 'A red fox',
      quality: 'auto'
    })

    expect(body.quality).toBeUndefined()
  })

  it('uses image for one Grok reference and images for multiple references', () => {
    const oneImage = buildGrokImagineImageRequestBody({
      model: 'grok-imagine-image-2.0',
      prompt: 'Turn this into a watercolor painting',
      imageDataUrls: ['data:image/png;base64,one']
    })
    const multipleImages = buildGrokImagineImageRequestBody({
      model: 'grok-imagine-image-2.0',
      prompt: 'Combine <IMAGE_0> and <IMAGE_1>',
      aspectRatio: '1:1',
      imageDataUrls: ['data:image/png;base64,one', 'data:image/png;base64,two']
    })

    expect(oneImage.image).toEqual({ url: 'data:image/png;base64,one', type: 'image_url' })
    expect(oneImage.images).toBeUndefined()
    expect(multipleImages.images).toEqual([
      { url: 'data:image/png;base64,one', type: 'image_url' },
      { url: 'data:image/png;base64,two', type: 'image_url' }
    ])
    expect(multipleImages.image).toBeUndefined()
    expect(multipleImages.aspect_ratio).toBe('1:1')
  })

  it('resolves the original prompt from a painting edit chain', () => {
    const root = { id: 'root', prompt: 'A cinematic city portrait.' }
    const child = { id: 'child', prompt: 'Change the background to night.', sourcePaintingId: root.id }
    const grandchild = {
      id: 'grandchild',
      prompt: 'Add warm window lights.',
      sourcePaintingId: child.id,
      basePrompt: 'A cinematic city portrait.'
    }

    expect(resolvePaintingBasePrompt(grandchild, [root, child, grandchild])).toBe('A cinematic city portrait.')
    expect(resolvePaintingBasePrompt(child, [root, child])).toBe('A cinematic city portrait.')
  })

  it('falls back to the current prompt when the source painting is unavailable', () => {
    expect(
      resolvePaintingBasePrompt({ id: 'child', prompt: 'Change the background.', sourcePaintingId: 'missing' }, [])
    ).toBe('Change the background.')
  })

  it('combines the original description with only the current edit request', () => {
    const prompt = composeImageEditPrompt('A person in a white suit.', 'Change the background to night.')

    expect(prompt).toContain('A person in a white suit.')
    expect(prompt).toContain('Change the background to night.')
    expect(prompt).toContain('keep all unspecified details unchanged')
    expect(prompt).not.toContain('previous edit')
  })

  it('keeps the current edit within the prompt limit when the original is very long', () => {
    const editPrompt = 'Change the lighting.'
    const prompt = composeImageEditPrompt('a'.repeat(10_000), editPrompt, 100)

    expect(prompt.length).toBeLessThanOrEqual(100)
    expect(prompt).toContain(editPrompt)
  })

  it('extracts mixed response formats in response order without duplicating an item', () => {
    expect(
      extractImageGenerationSources({
        data: [
          { url: 'https://example.com/one.png' },
          { b64_json: 'base64-two', url: 'https://example.com/two.png' },
          { b64_json: 'base64-three' },
          { url: '' }
        ]
      })
    ).toEqual([
      { kind: 'url', value: 'https://example.com/one.png' },
      { kind: 'base64', value: 'base64-two' },
      { kind: 'base64', value: 'base64-three' }
    ])
  })

  it('rejects responses without usable images', () => {
    expect(() => extractImageGenerationSources({ data: [{ revised_prompt: 'no image' }] })).toThrow(
      'Image generation returned no usable images.'
    )
    expect(() => extractImageGenerationSources({})).toThrow('data array')
  })

  it('validates supported formats and image size limits', () => {
    expect(isSupportedImageFile({ name: 'image.png', type: 'image/png' })).toBe(true)
    expect(isSupportedImageFile({ name: 'image.gif', type: 'image/gif' })).toBe(true)
    expect(isSupportedImageFile({ name: 'image.bmp', type: 'image/bmp' })).toBe(false)
    expect(validateImageInputFiles([{ name: 'empty.png', type: 'image/png', size: 0 }])).toEqual({
      code: 'empty_file',
      fileName: 'empty.png'
    })
    expect(validateImageInputFiles([{ name: 'large.png', type: 'image/png', size: 20 * 1024 * 1024 + 1 }])).toEqual({
      code: 'file_too_large',
      fileName: 'large.png',
      maxBytes: 20 * 1024 * 1024
    })
  })

  it('retries transient image API responses', async () => {
    vi.useFakeTimers()
    try {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const request = fetchImageGenerationRequest(
        'https://example.com/v1/images/generations',
        {},
        {
          fetchFn,
          maxRetries: 1
        }
      )

      await vi.advanceTimersByTimeAsync(1_000)
      await expect(request).resolves.toMatchObject({ status: 200 })
      expect(fetchFn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
