// Real Chromium transport, local mock only: never use user credentials or paid endpoints.
import assert from 'node:assert/strict'
import { randomFillSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

import { app, net } from 'electron'
import sharp from 'sharp'

import { generateStudioImages } from '../../src/main/services/imageCanvas/studio'
import { StudioAssetCache } from '../../src/main/services/imageCanvas/StudioAssetCache'

app.disableHardwareAcceleration()
app.setPath('userData', process.env.IMAGE_SMOKE_USER_DATA!)
void app.whenReady().then(async () => {
  const server = createServer()
  const deadline = setTimeout(() => {
    process.stderr.write('FAIL: Electron image transport timed out\n')
    app.exit(1)
  }, 20000)
  try {
    const bytes = await sharp(randomFillSync(Buffer.alloc(1024 * 1024 * 3)), {
      raw: { width: 1024, height: 1024, channels: 3 }
    })
      .png()
      .toBuffer()
    const assets: string[] = []
    let submissions = 0
    let checks = 0
    let serverError: unknown
    server.on('request', (req, res) => {
      void (async () => {
        assert.equal(req.headers.authorization, 'Bearer offline-image-test')
        const reply = (data: unknown) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ success: true, data }))
        }
        if (req.url === '/api/image-studio/bootstrap') {
          reply({
            submission_lookup: true,
            asset_reuse: true,
            models: [
              {
                id: 'gpt-image-test',
                protocol: 'images',
                sizes: ['auto'],
                qualities: [],
                backgrounds: [],
                max_references: 4,
                max_images: 1
              }
            ]
          })
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const body = Buffer.concat(chunks)
        if (req.method === 'HEAD') {
          assert.equal(body.length, 0)
          assert.ok(
            req.url === '/api/image-studio/assets/' + assets[0] ||
              req.url === '/api/image-studio/assets/' + 'a'.repeat(64)
          )
          checks++
          res.writeHead(200)
          res.end()
          return
        }
        if (req.method === 'POST' && req.url === '/api/image-studio/assets') {
          const decoded = await new Request('http://127.0.0.1', {
            method: 'POST',
            headers: { 'Content-Type': req.headers['content-type']! },
            body: new Uint8Array(body)
          }).formData()
          const file = decoded.get('image')
          assert.ok(file instanceof File)
          assert.equal(file.type, 'image/png')
          assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes)
          const id = randomUUID()
          assets.push(id)
          reply({ id })
          return
        }
        if (req.method === 'POST' && req.url === '/api/image-studio/jobs') {
          assert.equal(assets.length, 1)
          const expected = submissions === 0 ? assets[0] : 'a'.repeat(64)
          assert.deepEqual(JSON.parse(body.toString()).asset_ids, [expected, expected])
          submissions++
          reply({ job: { state: 'succeeded' }, assets: ['a'.repeat(64)] })
          return
        }
        assert.equal(req.url, '/api/image-studio/assets/' + 'a'.repeat(64))
        res.setHeader('Content-Type', 'image/png')
        res.end(bytes)
      })().catch((error) => {
        serverError = error
        res.writeHead(500)
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const provider = {
      id: 'offline',
      name: 'Offline',
      apiHost: `http://127.0.0.1:${address.port}`,
      apiKey: 'offline-image-test',
      models: [{ id: 'gpt-image-test', name: 'Test', protocol: 'openai' as const }]
    }
    const reference = `data:image/png;base64,${bytes.toString('base64')}`
    const generate = (cache: StudioAssetCache) =>
      generateStudioImages(
        provider,
        {
          id: randomUUID(),
          providerId: provider.id,
          modelId: 'gpt-image-test',
          prompt: 'offline edit',
          references: [reference, reference],
          size: 'auto',
          quality: 'auto',
          background: 'auto',
          count: 1
        },
        (url, init) => net.fetch(url instanceof URL ? url.href : url, init),
        () => {},
        undefined,
        cache.forScope('b'.repeat(64))
      )
    const images = await generate(new StudioAssetCache(app.getPath('userData')))
    const restored = await generate(new StudioAssetCache(app.getPath('userData')))
    if (serverError) throw serverError
    assert.equal(submissions, 2)
    assert.equal(assets.length, 1)
    assert.equal(checks, 3)
    assert.equal(images.length, 1)
    assert.deepEqual(images[0], bytes)
    assert.deepEqual(restored[0], bytes)
    process.stdout.write(
      'PASS: 3 MB PNG uploaded intact via Electron; duplicate reference and downloaded result reused across cache restart; HEAD checks transfer no image; exactly two requested mock jobs. No paid requests.\n'
    )
    app.exit(0)
  } catch (error) {
    process.stderr.write(`FAIL: ${String(error)}\n`)
    app.exit(1)
  } finally {
    clearTimeout(deadline)
    server.closeAllConnections()
    server.close()
  }
})
