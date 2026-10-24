import { randomUUID } from 'node:crypto'

import type { ImageCanvasProvider, ImageCanvasRequest } from '@shared/config/imageCanvas'
import sharp from 'sharp'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { generateCanvasImages, imageEndpoint, validateCanvasRequest } from '../protocol'

let png: Buffer
let reference: string
const input = (): ImageCanvasRequest => ({
  id: randomUUID(),
  providerId: 'provider',
  modelId: 'gpt-image-test',
  prompt: 'a red house',
  references: [],
  size: '1:1',
  quality: 'auto',
  background: '',
  count: 1
})
const provider = (protocol: 'openai' | 'gemini' | 'seedream' = 'openai'): ImageCanvasProvider => ({
  id: 'provider',
  name: 'Configured gateway',
  apiHost: 'https://example.test/custom#',
  apiKey: 'secret-key',
  headers: { 'x-custom-gateway': 'workspace' },
  models: [{ id: 'gpt-image-test', name: 'image', protocol }]
})
beforeAll(async () => {
  png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  reference = `data:image/png;base64,${png.toString('base64')}`
})
const result = () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))

describe('image canvas protocol adapters', () => {
  it('honors explicit proxy paths and standard API versions', () => {
    expect(imageEndpoint('https://proxy.test/custom#', 'openai', '/images/generations')).toBe(
      'https://proxy.test/custom/images/generations'
    )
    expect(imageEndpoint('https://proxy.test/v1/', 'openai', '/images/generations')).toBe(
      'https://proxy.test/v1/images/generations'
    )
    expect(imageEndpoint('https://ark.cn-beijing.volces.com', 'seedream', '/images/generations')).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/images/generations'
    )
    expect(
      imageEndpoint('https://generativelanguage.googleapis.com', 'gemini', '/models/test:generateContent')
    ).toContain('/v1beta/models/')
    expect(() => imageEndpoint('file:///etc', 'openai', '')).toThrow()
  })

  it('posts OpenAI JSON without the unsupported GPT Image response_format', async () => {
    const request = vi.fn().mockResolvedValue(result())
    expect(await generateCanvasImages(provider(), input(), request)).toEqual([png])
    const [url, init] = request.mock.calls[0]
    expect(url).toBe('https://example.test/custom/images/generations')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-key')
    expect(JSON.parse(init.body)).toEqual({ model: 'gpt-image-test', prompt: 'a red house', size: '1024x1024', n: 1 })
    expect(init.redirect).toBe('error')
  })

  it('uses actual multipart image bytes for an OpenAI reference edit', async () => {
    const request = vi.fn().mockResolvedValue(result())
    await generateCanvasImages(provider(), { ...input(), references: [reference] }, request)
    const [url, init] = request.mock.calls[0]
    const form = init.body as FormData
    expect(url).toContain('/images/edits')
    expect(form.get('prompt')).toBe('a red house')
    expect(Buffer.from(await (form.get('image') as Blob).arrayBuffer())).toEqual(png)
    expect(new Headers(init.headers).has('content-type')).toBe(false)
  })

  it('uses Gemini native fields and excludes thought images', async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
                  { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }
                ]
              }
            }
          ]
        })
      )
    )
    expect(await generateCanvasImages(provider('gemini'), { ...input(), references: [reference] }, request)).toEqual([
      png
    ])
    const [url, init] = request.mock.calls[0]
    expect(url).toContain('/models/gpt-image-test:generateContent')
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe('secret-key')
    const body = JSON.parse(init.body)
    expect(body.contents[0].parts[1].inlineData.data).toBe(png.toString('base64'))
    expect(body.generationConfig.imageConfig.aspectRatio).toBe('1:1')
    expect(body).not.toHaveProperty('n')
  })

  it('sends Seedream reference data URLs to the generation route', async () => {
    const request = vi.fn().mockResolvedValue(result())
    await generateCanvasImages(provider('seedream'), { ...input(), references: [reference] }, request)
    const [url, init] = request.mock.calls[0]
    expect(url).toContain('/images/generations')
    const body = JSON.parse(init.body)
    expect(body.image).toEqual([reference])
    expect(body.size).toBe('2048x2048')
    expect(body).not.toHaveProperty('n')
    expect(body).not.toHaveProperty('quality')
  })

  it('passes Gemini resolution preferences to the upstream and rejects malformed ratios', async () => {
    const configured = provider('gemini')
    configured.models[0].id = 'gemini-3-pro-image-preview'
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: png.toString('base64') } }] } }] })
        )
      )
    await generateCanvasImages(configured, { ...input(), modelId: configured.models[0].id, size: '2048x2048' }, request)
    expect(JSON.parse(request.mock.calls[0][1].body).generationConfig.imageConfig).toEqual({
      aspectRatio: '1:1',
      imageSize: '2K'
    })
    request.mockClear()
    request.mockResolvedValue(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: png.toString('base64') } }] } }] })
      )
    )
    await generateCanvasImages(
      configured,
      { ...input(), modelId: configured.models[0].id, size: '2880x2880', resolution: '4K' },
      request
    )
    expect(JSON.parse(request.mock.calls[0][1].body).generationConfig.imageConfig.imageSize).toBe('4K')
    request.mockClear()
    configured.models[0].id = 'gemini-2.5-flash-image'
    request.mockResolvedValue(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: png.toString('base64') } }] } }] })
      )
    )
    await generateCanvasImages(configured, { ...input(), modelId: configured.models[0].id, size: '2048x2048' }, request)
    expect(JSON.parse(request.mock.calls[0][1].body).generationConfig.imageConfig.imageSize).toBe('2K')
    request.mockClear()
    await expect(
      generateCanvasImages(configured, { ...input(), modelId: configured.models[0].id, size: '7:5' }, request)
    ).rejects.toThrow('gemini_size_unsupported')
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects invalid models, reference data, counts and provider errors without retries', async () => {
    const request = vi.fn().mockResolvedValue(new Response('secret-key must never be echoed', { status: 429 }))
    await expect(generateCanvasImages(provider(), { ...input(), modelId: 'unknown' }, request)).rejects.toThrow(
      'model_unavailable'
    )
    expect(request).not.toHaveBeenCalled()
    expect(() => validateCanvasRequest({ ...input(), count: 20 })).toThrow()
    expect(() => validateCanvasRequest({ ...input(), references: ['data:image/png;base64,YWJj'] })).toThrow(
      'invalid_image'
    )
    await expect(generateCanvasImages(provider(), input(), request)).rejects.toThrow('upstream_http_429')
    expect(request).toHaveBeenCalledOnce()
  })
  it('rejects an unsupported legacy OpenAI ratio before any paid POST', async () => {
    const request = vi.fn()
    await expect(generateCanvasImages(provider(), { ...input(), size: '16:9' }, request)).rejects.toThrow(
      'image_dimensions_unsupported'
    )
    expect(request).not.toHaveBeenCalled()
  })
  it('sends multiple reference bytes and n in one edit request', async () => {
    const request = vi.fn().mockResolvedValue(result())
    await generateCanvasImages(provider(), { ...input(), count: 2, references: [reference, reference] }, request)
    expect(request).toHaveBeenCalledOnce()
    const body = request.mock.calls[0][1].body as FormData
    expect(body.get('n')).toBe('2')
    expect(body.getAll('image[]')).toHaveLength(2)
  })
  it('keeps the resolution when a Gemini request uses a ratio directly', async () => {
    const configured = provider('gemini')
    configured.models[0].id = 'gemini-3-pro-image-preview'
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: png.toString('base64') } }] } }] })
        )
      )
    await generateCanvasImages(
      configured,
      { ...input(), modelId: configured.models[0].id, size: '16:9', aspectRatio: '16:9', resolution: '4K' },
      request
    )
    expect(JSON.parse(request.mock.calls[0][1].body).generationConfig.imageConfig).toEqual({
      aspectRatio: '16:9',
      imageSize: '4K'
    })
  })
})
