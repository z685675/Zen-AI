// pnpm exec tsx scripts/opencode-attachment-smoke.ts [packaged-resources-directory]
// Real pinned native executable, isolated HOME/config, generated fixtures, loopback mock only.
// A FAIL is intentional evidence, not an expected-failure exemption. No runtime behavior is patched.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import sharp from 'sharp'

import { OpenCodeClient, type OpenCodeEvent } from '../src/main/services/agents/services/opencode/client'
import { discardEmptyNativeCompaction } from '../src/main/services/agents/services/opencode/compactionGuard'
import { buildOpenCodeEnvironment, OPENCODE_VERSION } from '../src/main/services/agents/services/opencode/config'
import { prepareOpenCodeOfflineConfig } from '../src/main/services/agents/services/opencode/offline'

export const IMAGE_LIMIT = 5 * 1024 * 1024
const EVENT_LIMIT = 64 * 1024 * 1024
const TEMP_PREFIX = 'zen-opencode-attachments-'
const MODEL = { providerID: 'attachment-smoke', modelID: 'local-only' }
type Message = { info: Record<string, any>; parts: Array<Record<string, any>> }
type Audit = { kind: 'summary' | 'turn'; bytes: number; body: Record<string, any> }

// Independent observer: lets us distinguish native delivery from the product client's frame guard.
// Bounded, fragmentation-safe, handles CRLF split across chunks, and releases every stream in finally.
export async function* decodeEvents(chunks: AsyncIterable<Uint8Array>, limit = EVENT_LIMIT) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary: RegExpExecArray | null
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const bytes = Buffer.byteLength(frame)
      if (bytes > limit) throw new Error(`Observer event frame exceeded ${limit} bytes`)
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data && data !== '[DONE]') yield { event: JSON.parse(data) as OpenCodeEvent, bytes }
    }
    if (Buffer.byteLength(buffer) > limit) throw new Error(`Observer event frame exceeded ${limit} bytes`)
  }
  buffer += decoder.decode()
  if (buffer.trim()) throw new Error('Observer event stream ended with an incomplete frame')
}

export function hasCompletedSummary(messages: Message[]) {
  return messages.some(
    ({ info, parts }) =>
      info.role === 'assistant' &&
      info.summary === true &&
      Boolean(info.finish) &&
      !info.error &&
      parts.some((part) => part.type === 'text' && part.text?.trim())
  )
}

export function assertTextOnlySummary(body: unknown) {
  const serialized = JSON.stringify(body)
  assert(!serialized.includes(';base64,'), 'Compaction request leaked a base64 data URL')
  assert(!/"(?:image_url|file_data|data)"\s*:/.test(serialized), 'Compaction request contains media fields')
  assert(!/[A-Za-z0-9+/]{1024}/.test(serialized), 'Compaction request contains a base64-sized opaque run')
}

export function assertScopedTemp(root: string) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()), 'Unexpected cleanup parent')
  assert(path.basename(root).startsWith(TEMP_PREFIX), 'Unexpected cleanup basename')
}

// One-page structurally valid PDF with a large uncompressed content stream; no parser/download dependency.
export function makePdf(bytes = 9_900_000) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${bytes} >>\nstream\n${' '.repeat(bytes - 4)}q\nQ\nendstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const start = Buffer.byteLength(pdf)
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(pdf)
}

async function imageInfo(url: string) {
  const match = /^data:(image\/[^;]+);base64,(.*)$/s.exec(url)
  assert(match, 'Expected a native base64 image')
  const metadata = await sharp(Buffer.from(match[2], 'base64')).metadata()
  return { mime: match[1], base64Bytes: Buffer.byteLength(match[2]), width: metadata.width, height: metadata.height }
}

async function assertResized(url: string) {
  const info = await imageInfo(url)
  assert(info.width > 0 && info.width <= 2000 && info.height > 0 && info.height <= 2000, JSON.stringify(info))
  assert(info.base64Bytes <= IMAGE_LIMIT, JSON.stringify(info))
  return info
}

function imageUrls(body: Audit['body']) {
  return body.messages.flatMap((message: any) =>
    Array.isArray(message.content)
      ? message.content.filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url)
      : []
  ) as string[]
}

async function main() {
  assert(process.argv.length <= 3, 'Usage: pnpm exec tsx scripts/opencode-attachment-smoke.ts [resources]')
  const resources = process.argv[2] ? path.resolve(process.argv[2]) : undefined
  const require = createRequire(__filename)
  const wrapperRequire = createRequire(require.resolve('opencode-ai/package.json'))
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const executable = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  const binary = resources
    ? path.join(resources, 'opencode', `${platform}-${process.arch}`, executable)
    : path.join(
        path.dirname(
          wrapperRequire.resolve(
            `opencode-${platform}-${process.arch}${process.arch === 'x64' ? '-baseline' : ''}/package.json`
          )
        ),
        'bin',
        executable
      )
  const root = await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX))
  const workspace = path.join(root, 'workspace')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Attachment smoke exceeded 180 seconds')), 180_000)
  const audits: Audit[] = []
  const unexpectedRoutes: string[] = []
  const results: Array<{ name: string; status: 'PASS' | 'FAIL'; detail: unknown }> = []
  let mode: 'normal' | 'read-pdf' | 'fail-summary' = 'normal'
  let summaryReply = 'LOCAL_SUMMARY_CHECKPOINT'
  const pdfPath = path.join(workspace, 'large-9.9MB.pdf')
  const mock = createServer((req, res) => {
    void (async () => {
      if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
        unexpectedRoutes.push(`${req.method} ${req.url}`)
        res.writeHead(404).end()
        return
      }
      assert.equal(req.headers.authorization, 'Bearer local-placeholder')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks)
      const body = JSON.parse(raw.toString())
      assert.equal(body.model, MODEL.modelID)
      const serialized = JSON.stringify(body.messages)
      const summary = serialized.includes('<conversation>') && serialized.includes('anchored summary')
      audits.push({ kind: summary ? 'summary' : 'turn', bytes: raw.length, body })
      if (summary && mode === 'fail-summary') {
        res
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'LOCAL_COMPACTION_FAILURE', type: 'invalid_request_error' } }))
        return
      }
      const tool = mode === 'read-pdf' && !summary && !body.messages.some((message: any) => message.role === 'tool')
      const delta = tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'call_local_read_pdf',
                type: 'function',
                function: { name: 'read', arguments: JSON.stringify({ filePath: pdfPath }) }
              }
            ]
          }
        : { content: summary ? summaryReply : 'LOCAL_MOCK_REPLY' }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`)
      const base = { id: 'chatcmpl_local', object: 'chat.completion.chunk', created: 1, model: MODEL.modelID }
      chunk({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })
      chunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 2000, completion_tokens: 20, total_tokens: 2020 }
      })
      res.end('data: [DONE]\n\n')
    })().catch((error) => {
      unexpectedRoutes.push(`Mock failure: ${error.message}`)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  let child: ReturnType<typeof spawn> | undefined
  let client: OpenCodeClient | undefined
  let address = ''
  let stderr = ''
  const password = 'local-smoke-password'
  const headers = {
    Authorization: `Basic ${Buffer.from(`zen-ai:${password}`).toString('base64')}`,
    'Content-Type': 'application/json',
    'x-opencode-directory': encodeURIComponent(workspace)
  }
  const check = async (name: string, run: () => Promise<unknown>) => {
    try {
      const detail = await run()
      results.push({ name, status: 'PASS', detail })
      process.stdout.write(`PASS ${name}: ${JSON.stringify(detail)}\n`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      results.push({ name, status: 'FAIL', detail })
      process.stderr.write(`FAIL ${name}: ${detail}\n`)
      process.exitCode = 1
    }
  }
  try {
    await mkdir(workspace, { recursive: true })
    await prepareOpenCodeOfflineConfig(
      root,
      resources ? path.join(resources, 'opencode-runtime') : path.resolve(__dirname, '../resources/opencode-runtime')
    )
    mock.listen(0, '127.0.0.1')
    await once(mock, 'listening')
    const port = (mock.address() as { port: number }).port
    // Deliberately do not inherit proxies, credentials, MCPs, project config or user providers.
    const env = buildOpenCodeEnvironment(process.env, root, password)
    for (const key of Object.keys(env)) if (/^(?:https?|all)_proxy$/i.test(key)) delete env[key]
    env.NO_PROXY = '*'
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: `${MODEL.providerID}/${MODEL.modelID}`,
      small_model: `${MODEL.providerID}/${MODEL.modelID}`,
      enabled_providers: [MODEL.providerID],
      autoupdate: false,
      share: 'disabled',
      plugin: [],
      snapshot: false,
      lsp: false,
      formatter: false,
      mcp: {},
      instructions: [],
      skills: { paths: [], urls: [] },
      agent: { title: { disable: true } },
      permission: { '*': 'deny', read: 'allow' },
      compaction: { auto: true, prune: true, reserved: 24000, preserve_recent_tokens: 8000 },
      provider: {
        [MODEL.providerID]: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Loopback attachment smoke only',
          env: [],
          options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'local-placeholder' },
          models: {
            [MODEL.modelID]: {
              id: MODEL.modelID,
              name: 'Local mock',
              attachment: true,
              tool_call: true,
              limit: { context: 128000, output: 16000 },
              // Match the product config: PDF media is not declared as a supported model input.
              modalities: { input: ['text', 'image'], output: ['text'] }
            }
          }
        }
      }
    })
    child = spawn(binary, ['serve', '--hostname=127.0.0.1', '--port=0', '--no-mdns', '--pure', '--log-level=WARN'], {
      cwd: workspace,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stderr!.on('data', (data) => {
      stderr = (stderr + data).slice(-6000)
    })
    address = await new Promise<string>((resolve, reject) => {
      let stdout = ''
      const abort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', abort, { once: true })
      child!.stdout!.on('data', (data) => {
        stdout += data
        const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)
        if (match) {
          controller.signal.removeEventListener('abort', abort)
          resolve(match[1])
        }
      })
      child!.once('error', reject)
      child!.once('exit', (code) => reject(new Error(`Native process exited ${code}: ${stderr}`)))
    })
    client = new OpenCodeClient(address, password, workspace)
    const health = await client.request<any>('/global/health', 'GET', undefined, controller.signal)
    assert.equal(health.version, '1.19.4')
    assert.equal(health.version, OPENCODE_VERSION)
    assert(health.healthy)
    process.stdout.write(`NATIVE ${health.version} ${binary}\n`)
    const session = async (title: string) =>
      (await client!.request<{ id: string }>('/session', 'POST', { title }, controller.signal)).id
    const history = (id: string) =>
      client!.request<Message[]>(`/session/${id}/message`, 'GET', undefined, controller.signal)
    const observed = async (id: string, submit: () => Promise<unknown>, productObserver = false) => {
      const local = new AbortController()
      const timer = setTimeout(() => local.abort(new Error('Native operation exceeded 35 seconds')), 35000)
      const signal = AbortSignal.any([local.signal, controller.signal])
      const stream = await fetch(`${address}/event`, { headers, signal })
      assert(stream.ok && stream.body, 'Native observer handshake failed')
      const reader = stream.body.getReader()
      async function* chunks() {
        while (true) {
          const next = await reader.read()
          if (next.done) return
          yield next.value
        }
      }
      const iterator = decodeEvents(chunks())
      let productError: string | undefined
      let productSawPdf = false
      let productTask: Promise<void> | undefined
      let maxEventBytes = 0
      const events: OpenCodeEvent[] = []
      let completedPdfBytes = 0
      try {
        await iterator.next() // native server.connected handshake precedes submission
        if (productObserver) {
          const productIterator = client!.events(signal)
          await productIterator.next()
          productTask = (async () => {
            try {
              for await (const event of productIterator) {
                if (event.properties.part?.state?.attachments?.some((file: any) => file.mime === 'application/pdf'))
                  productSawPdf = true
              }
            } catch (error) {
              if (!signal.aborted) productError = error instanceof Error ? error.message : String(error)
            }
          })()
        }
        // Start consuming before submission: /summarize is synchronous; /prompt_async returns 204.
        const consume = (async () => {
          let busy = false
          for await (const { event, bytes } of iterator) {
            const properties = event.properties
            if (properties.sessionID !== id && properties.info?.sessionID !== id && properties.part?.sessionID !== id)
              continue
            maxEventBytes = Math.max(maxEventBytes, bytes)
            const part = properties.part
            if (part?.type === 'tool' && part.state.status === 'completed') {
              const pdf = part.state.attachments?.find((file: any) => file.mime === 'application/pdf')
              if (pdf) completedPdfBytes = Buffer.from(pdf.url.split(',')[1], 'base64').length
            }
            // Never keep event attachment/base64 bodies in reports.
            if (event.type === 'session.error' || event.type === 'session.compacted') events.push(event)
            if (event.type === 'session.status' && properties.status.type === 'busy') busy = true
            if (busy && event.type === 'session.status' && properties.status.type === 'idle') return
          }
          throw new Error('Native event stream ended before idle')
        })()
        await Promise.all([consume, submit()])
        return { maxEventBytes, completedPdfBytes, events, productError, productSawPdf }
      } finally {
        clearTimeout(timer)
        local.abort()
        await reader.cancel().catch(() => undefined)
        await iterator.return(undefined).catch(() => undefined)
        await productTask
      }
    }
    const turn = async (id: string, parts: unknown[], productObserver = false) => {
      const result = await observed(
        id,
        () => client!.request(`/session/${id}/prompt_async`, 'POST', { model: MODEL, parts }, controller.signal),
        productObserver
      )
      assert.equal(
        result.events.filter((event) => event.type === 'session.error').length,
        0,
        JSON.stringify(result.events)
      )
      const messages = await history(id)
      assert(
        messages.some((message) => message.parts.some((part) => part.text === 'LOCAL_MOCK_REPLY')),
        'Native reply missing'
      )
      return result
    }
    // Deterministic high-entropy pixels exercise both dimension and encoded-byte limits.
    const width = 3200,
      height = 2400
    const pixels = Buffer.alloc(width * height * 3)
    let seed = 0x12345678
    for (let index = 0; index < pixels.length; index++) {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      pixels[index] = seed & 255
    }
    const png = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer()
    const jpeg = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
      .toBuffer()
    const pngPath = path.join(workspace, 'oversized.png')
    const jpegPath = path.join(workspace, 'oversized.jpg')
    const textPath = path.join(workspace, 'notes.txt')
    const pdf = makePdf()
    await Promise.all([
      writeFile(pngPath, png),
      writeFile(jpegPath, jpeg),
      writeFile(pdfPath, pdf),
      writeFile(textPath, 'MULTI_FILE_TEXT_SENTINEL')
    ])
    const file = (filePath: string, mime: string) => ({
      type: 'file',
      mime,
      filename: path.basename(filePath),
      url: pathToFileURL(filePath).href
    })
    for (const [name, source, mime, input] of [
      ['PNG file URL', png, 'image/png', file(pngPath, 'image/png')],
      [
        'JPEG data URL',
        jpeg,
        'image/jpeg',
        {
          type: 'file',
          mime: 'image/jpeg',
          filename: 'oversized.jpg',
          url: `data:image/jpeg;base64,${jpeg.toString('base64')}`
        }
      ]
    ] as const) {
      await check(`oversized ${name}`, async () => {
        assert(source.toString('base64').length > IMAGE_LIMIT, 'Fixture must exceed encoded limit')
        const id = await session(name)
        const start = audits.length
        await turn(id, [{ type: 'text', text: `Inspect ${mime}` }, input])
        const urls = audits.slice(start).flatMap((audit) => imageUrls(audit.body))
        assert.equal(urls.length, 1, 'Model must receive exactly one image')
        const output = await assertResized(urls[0])
        const saved = (await history(id)).flatMap((message) => message.parts).find((part) => part.type === 'file')
        assert(saved, 'Normalized file not persisted')
        await assertResized(saved.url)
        return {
          inputBytes: source.length,
          inputBase64Bytes: source.toString('base64').length,
          inputDimensions: `${width}x${height}`,
          output
        }
      })
    }
    await check('multi-file PNG + JPEG + text', async () => {
      const id = await session('Multi-file')
      const start = audits.length
      await turn(id, [
        { type: 'text', text: 'Inspect all files' },
        file(pngPath, 'image/png'),
        file(jpegPath, 'image/jpeg'),
        file(textPath, 'text/plain')
      ])
      const requests = audits.slice(start)
      const urls = requests.flatMap((audit) => imageUrls(audit.body))
      assert.equal(urls.length, 2)
      assert(JSON.stringify(requests.map((audit) => audit.body.messages)).includes('MULTI_FILE_TEXT_SENTINEL'))
      return {
        images: await Promise.all(urls.map(assertResized)),
        textRetained: true,
        requestBytes: requests.map((audit) => audit.bytes)
      }
    })
    const pdfSession = await session('Native PDF read and compaction')
    let pdfObservation: Awaited<ReturnType<typeof observed>> | undefined
    await check('native 9.9MB PDF read and large event', async () => {
      mode = 'read-pdf'
      const start = audits.length
      try {
        pdfObservation = await turn(pdfSession, [{ type: 'text', text: `READ_LARGE_PDF ${pdfPath}` }], true)
        assert.equal(pdfObservation.completedPdfBytes, pdf.length, 'Native tool did not attach the complete PDF')
        assert(pdfObservation.maxEventBytes > 8_000_000, 'Expected a PDF event larger than the old client guard')
        const providerRequests = audits.slice(start)
        const providerMessages = JSON.stringify(providerRequests.map((audit) => audit.body.messages))
        const unsupportedPdfNotice = providerMessages.includes('this model does not support pdf input')
        assert(unsupportedPdfNotice, 'Expected native PDF unsupported-input notice for the product image-only model')
        assert(
          !providerMessages.includes('data:application/pdf;base64,'),
          'Unsupported PDF was sent to an image-only provider'
        )
        return {
          fixtureBytes: pdf.length,
          ...pdfObservation,
          unsupportedPdfNotice,
          note: 'PDF is not resized; native emits the complete base64 attachment. UI rendering is outside this harness.'
        }
      } finally {
        mode = 'normal'
      }
    })
    await check('product client consumes native large PDF event', async () => {
      assert(pdfObservation, 'Native PDF operation did not complete')
      assert(!pdfObservation.productError, pdfObservation.productError)
      assert(pdfObservation.productSawPdf, 'Product client did not consume the PDF attachment event')
      return { productSawPdf: true, uiRenderingTested: false }
    })
    await check('native compaction strips base64 and retains recent turns / paths', async () => {
      // Force media into the old head while leaving short recent turns eligible for the 8000-token tail.
      await turn(pdfSession, [{ type: 'text', text: 'OLD_IMAGE_FOR_SUMMARY' }, file(pngPath, 'image/png')])
      for (const text of ['RECENT_TURN_ONE exact decision purple', `RECENT_TURN_TWO keep path ${textPath}`]) {
        await turn(pdfSession, [{ type: 'text', text }])
      }
      const before = await history(pdfSession)
      const start = audits.length
      summaryReply = `LOCAL_SUMMARY_CHECKPOINT\nRelevant files: ${pdfPath}\n${pngPath}`
      const result = await observed(pdfSession, () =>
        client!.request(`/session/${pdfSession}/summarize`, 'POST', MODEL, controller.signal)
      )
      const summaries = audits.slice(start).filter((audit) => audit.kind === 'summary')
      assert.equal(summaries.length, 1, 'Expected exactly one summary model request')
      assertTextOnlySummary(summaries[0].body)
      const serialized = JSON.stringify(summaries[0].body)
      assert(
        serialized.includes('large-9.9MB.pdf') && serialized.includes('oversized.png'),
        'Summary input lost file paths/names'
      )
      assert(serialized.includes('[Attached application/pdf:'), 'Tool PDF attachment descriptor lost')
      assert(
        result.events.some((event) => event.type === 'session.compacted'),
        'Successful compaction event missing'
      )
      const after = await history(pdfSession)
      assert(hasCompletedSummary(after), 'Finished error-free summary checkpoint missing')
      assert(
        before.every((message) => after.some((item) => item.info.id === message.info.id)),
        'Compaction deleted stored history'
      )
      assert(
        after.some((message) => message.parts.some((part) => part.type === 'compaction' && part.tail_start_id)),
        'Retained-tail checkpoint missing'
      )
      const nextStart = audits.length
      await turn(pdfSession, [{ type: 'text', text: 'AFTER_COMPACTION' }])
      const next = JSON.stringify(audits.slice(nextStart).map((audit) => audit.body.messages))
      assert(next.includes('LOCAL_SUMMARY_CHECKPOINT'))
      assert(
        next.includes('RECENT_TURN_ONE') && next.includes('RECENT_TURN_TWO'),
        'Next model request lost recent turns'
      )
      assert(
        next.includes('notes.txt') && next.includes('large-9.9MB.pdf'),
        'Next model request lost file path context'
      )
      return {
        summaryBytes: summaries[0].bytes,
        base64Absent: true,
        recentTurnsRetained: true,
        originalHistoryRetained: true,
        events: result.events.map((event) => event.type)
      }
    })
    await check('failed native compaction never reports success / hides history', async () => {
      const id = await session('Failed compaction')
      await turn(id, [{ type: 'text', text: 'FAILURE_HISTORY_SENTINEL' }])
      const start = audits.length
      mode = 'fail-summary'
      let result: Awaited<ReturnType<typeof observed>>
      try {
        result = await observed(id, () => client!.request(`/session/${id}/summarize`, 'POST', MODEL, controller.signal))
      } finally {
        mode = 'normal'
      }
      assert(
        audits.slice(start).some((audit) => audit.kind === 'summary'),
        'Failure mock was not exercised'
      )
      const messages = await history(id)
      assert(!hasCompletedSummary(messages), 'Failed summary falsely accepted as a completed checkpoint')
      const failed = messages.find((message) => message.info.summary && message.info.error)
      assert(failed, 'Failed summary did not persist its error')
      assert(!result.events.some((event) => event.type === 'session.compacted'), 'Failed compaction emitted success')
      assert(
        result.events.some((event) => event.type === 'session.error'),
        'Failed compaction emitted no error'
      )
      const nextStart = audits.length
      await turn(id, [{ type: 'text', text: 'CONTINUE_AFTER_FAILED_COMPACTION' }])
      assert(
        JSON.stringify(audits.slice(nextStart).map((audit) => audit.body.messages)).includes(
          'FAILURE_HISTORY_SENTINEL'
        ),
        'Failed compaction hid original context'
      )
      return {
        summaryFlagOnFailedMessage: failed.info.summary,
        error: failed.info.error.name,
        successEventAbsent: true,
        historyStillSent: true
      }
    })
    await check('empty native compaction is discarded without losing original context', async () => {
      const id = await session('Empty compaction guard')
      await turn(id, [{ type: 'text', text: 'EMPTY_SUMMARY_ORIGINAL_SENTINEL' }])
      summaryReply = ''
      try {
        await observed(id, () => client!.request(`/session/${id}/summarize`, 'POST', MODEL, controller.signal))
      } finally {
        summaryReply = 'LOCAL_SUMMARY_CHECKPOINT'
      }
      const before = await history(id)
      assert(!hasCompletedSummary(before), 'Empty summary must not count as usable context')
      assert(
        before.some(({ info }) => info.summary && info.finish && !info.error),
        'Expected native empty-summary boundary'
      )
      assert(
        await discardEmptyNativeCompaction(client!, id, before as any, controller.signal),
        'Empty checkpoint not discarded'
      )
      const after = await history(id)
      assert(!after.some(({ info }) => info.summary), 'Empty summary still exists')
      assert(after.some(({ parts }) => parts.some((part) => part.text === 'EMPTY_SUMMARY_ORIGINAL_SENTINEL')))
      const start = audits.length
      await turn(id, [{ type: 'text', text: 'CONTINUE_AFTER_EMPTY_SUMMARY' }])
      assert(
        JSON.stringify(audits.slice(start).map((audit) => audit.body.messages)).includes(
          'EMPTY_SUMMARY_ORIGINAL_SENTINEL'
        ),
        'Guard failed to restore original context for the next request'
      )
      return { nativeEmptyCheckpointDetected: true, originalContextRestored: true, paidRequests: 0 }
    })
    await check('loopback mock / native still healthy', async () => {
      assert.deepEqual(unexpectedRoutes, [])
      assert((await client!.request<any>('/global/health')).healthy)
      return { mockRequests: audits.length, paidRequests: 0, provider: 'loopback-only', unexpectedRoutes }
    })
    process.stdout.write(
      `RESULT ${JSON.stringify({ version: health.version, results, mockRequests: audits.length, paidRequests: 0 })}\n`
    )
  } finally {
    clearTimeout(timeout)
    controller.abort()
    if (client) await client.request('/global/dispose', 'POST').catch(() => undefined)
    if (child && child.exitCode === null) {
      child.kill()
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000).unref())])
    }
    mock.closeAllConnections()
    if (mock.listening) await new Promise<void>((resolve) => mock.close(() => resolve()))
    assertScopedTemp(root)
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    process.stdout.write(`CLEANUP ${root}\n`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
}
