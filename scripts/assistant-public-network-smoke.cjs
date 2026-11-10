// Real Electron transport regression: no external sites, user profile or window.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-public-network-'))
  const bundle = path.join(root, 'network.cjs')
  const { createRequire } = require('node:module')
  // tsx already supplies this build dependency; do not add a shipped runtime.
  createRequire(require.resolve('tsx/package.json'))('esbuild').buildSync({
    entryPoints: [path.join(__dirname, '../src/main/mcpServers/assistantPublicNetwork.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: bundle
  })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename, bundle, root], {
    env,
    windowsHide: true,
    timeout: 30_000,
    stdio: 'inherit'
  })
  // Only this invocation's verified temporary directory can be removed.
  if (
    path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) &&
    path.basename(root).startsWith('zen-public-network-')
  )
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  if (result.error) process.stderr.write(`${result.error.message}\n`)
  process.exit(result.status ?? 1)
}

const { app, session } = require('electron')
const { createServer } = require('node:http')
const { gzipSync } = require('node:zlib')
app.setPath('userData', path.join(process.argv[3], 'profile'))
app.disableHardwareAcceleration()
let server
let phase = 'startup'
const timer = setTimeout(() => app.exit(2), 25_000)
app
  .whenReady()
  .then(async () => {
    const { fetchAssistantPublic, requestPublicSource, readPublicBytes } = require(process.argv[2])
    const visits = []
    server = createServer((req, res) => {
      visits.push({ path: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization })
      if (req.url === '/redirect') return res.writeHead(302, { Location: '/article' }).end()
      if (req.url === '/private') return res.writeHead(302, { Location: 'https://127.0.0.1/private' }).end()
      if (req.url === '/downgrade') return res.writeHead(302, { Location: 'http://1.0.0.1/article' }).end()
      if (req.url === '/public') return res.writeHead(302, { Location: 'https://1.0.0.1/article' }).end()
      if (req.url === '/slow') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.write('begin')
        const interval = setInterval(() => res.write('progress'), 20)
        res.on('close', () => clearInterval(interval))
        return
      }
      if (req.url === '/large') return res.end(Buffer.alloc(17 * 1024 * 1024, 120))
      if (req.url === '/broken') {
        res.writeHead(200, { 'Content-Length': '100000' })
        res.write('partial')
        setTimeout(() => res.destroy(), 20)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip', 'Set-Cookie': 'source=secret' })
      res.end(gzipSync('Readable source 中文'))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    phase = 'manual redirect'
    // Fixture exercises the transport on loopback; production guards remain HTTPS/public-only.
    const redirect = await fetchAssistantPublic(`${base}/redirect`, { signal: AbortSignal.timeout(3000) })
    assert.equal(redirect.status, 302)
    assert.equal(new URL(redirect.headers.get('location')).pathname, '/article')
    assert.deepEqual(
      visits.map((item) => item.path),
      ['/redirect']
    )
    await session.fromPartition('zen-literature-public').cookies.set({ url: base, name: 'login', value: 'private' })
    phase = 'cookies and gzip'
    const response = await fetchAssistantPublic(`${base}/article`, {
      headers: { Cookie: 'private', Authorization: 'secret' },
      credentials: 'include'
    })
    assert.equal(response.headers.get('set-cookie'), null)
    assert.equal(response.headers.get('content-encoding'), null)
    assert.equal((await readPublicBytes(response, 1000)).toString(), 'Readable source 中文')
    assert.equal(visits.at(-1).cookie, undefined)
    assert.equal(visits.at(-1).authorization, undefined)
    const targets = []
    const transport = (url, init) => {
      targets.push(url)
      return fetchAssistantPublic(`${base}${new URL(url).pathname}`, init)
    }
    phase = 'validated redirect'
    const publicHop = await requestPublicSource(
      'https://1.1.1.1/public',
      AbortSignal.timeout(3000),
      'text/plain',
      transport
    )
    assert.equal((await readPublicBytes(publicHop.response, 1000)).toString(), 'Readable source 中文')
    assert.deepEqual(targets.splice(0), ['https://1.1.1.1/public', 'https://1.0.0.1/article'])
    for (const [route, message] of [
      ['private', /Private\/local/],
      ['downgrade', /Only public HTTPS/]
    ]) {
      await assert.rejects(
        requestPublicSource(`https://1.1.1.1/${route}`, AbortSignal.timeout(3000), 'text/plain', transport),
        message
      )
      assert.equal(targets.splice(0).length, 1)
    }
    const cancel = new AbortController()
    phase = 'cancellation'
    const ongoing = await fetchAssistantPublic(`${base}/slow`, { signal: cancel.signal })
    const reader = ongoing.body.getReader()
    assert.equal((await reader.read()).done, false)
    cancel.abort(new Error('fixture cancel'))
    await assert.rejects(reader.read(), /fixture cancel/)
    phase = 'interrupted body'
    const broken = await fetchAssistantPublic(`${base}/broken`, {})
    await assert.rejects(readPublicBytes(broken, 100000), /interrupted|closed|ERR_/i)
    phase = 'bounded body'
    const large = await fetchAssistantPublic(`${base}/large`, {})
    await assert.rejects(readPublicBytes(large, 20 * 1024 * 1024), /download limit/)
    process.stdout.write(
      'PASS real Electron: manual/public redirects, private/downgrade rejection, cookies, gzip, abort, interrupted and bounded bodies\n'
    )
  })
  .then(() => {
    clearTimeout(timer)
    server?.closeAllConnections()
    server?.close()
    app.exit(0)
  })
  .catch((error) => {
    process.stderr.write(`${phase}: ${error.stack}\n`)
    app.exit(1)
  })
