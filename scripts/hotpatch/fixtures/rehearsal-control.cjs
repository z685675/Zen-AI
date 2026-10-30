// Local acceptance operator. Copied beside (never inside) the test installer.
const crypto = require('node:crypto')
const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const { spawn } = require('node:child_process')

const root = __dirname
const operator = path.join(root, 'operator')
const config = JSON.parse(fs.readFileSync(path.join(operator, 'config.json'), 'utf8'))
if (config.format !== 'zen-local-patch-acceptance-v1' || !/^https:\/\/127\.0\.0\.1:\d+$/.test(config.origin)) {
  throw new Error('Not an isolated acceptance kit')
}
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
const writeAtomic = (name, value) => {
  const filename = path.join(operator, name)
  const temp = `${filename}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(temp, value, { flag: 'wx', mode: 0o600 })
  fs.renameSync(temp, filename)
}

async function request(route, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = https.request(
      config.origin + route,
      {
        ca: fs.readFileSync(path.join(operator, 'tls-cert.pem')),
        method,
        headers: { 'X-Local-Control': config.controlToken },
        timeout: 1500
      },
      (res) => {
        const chunks = []
        res.on('data', (data) => chunks.push(data))
        res.on('end', () => {
          if (res.statusCode !== 200) reject(new Error(`Local service HTTP ${res.statusCode}`))
          else resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('Local service timeout')))
    req.on('error', reject)
    req.end()
  })
}

async function startServer() {
  try {
    const state = await request('/health')
    if (state.base !== config.base.baseBuildId) throw new Error('Different acceptance kit owns this port')
    return
  } catch (error) {
    if (!['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error
  }
  const log = fs.openSync(path.join(root, 'server.log'), 'a')
  const child = spawn(process.execPath, [__filename, 'serve'], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  child.unref()
  fs.closeSync(log)
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      const state = await request('/health')
      if (state.base === config.base.baseBuildId) return
    } catch {
      /* Wait for the local listener, then report a bounded failure. */
    }
  }
  throw new Error('Local HTTPS service did not start; inspect server.log')
}

function publish(mode) {
  const lock = path.join(operator, 'publish.lock')
  const fd = fs.openSync(lock, 'wx')
  try {
    const previous = fs.existsSync(path.join(operator, 'sequence.json'))
      ? JSON.parse(fs.readFileSync(path.join(operator, 'sequence.json'), 'utf8'))
      : 0
    if (!Number.isSafeInteger(previous) || previous < 0) throw new Error('Invalid local policy sequence')
    const policy = {
      schemaVersion: 1,
      base: config.base,
      policySequence: previous + 1,
      issuedAt: Math.floor(Date.now() / 1000) - 1,
      expiresAt: Math.floor(Date.now() / 1000) + 6 * 86400,
      action: mode === 'rollback' ? 'rollback' : mode === 'pause' ? 'pause' : 'offer',
      target: ['rollback', 'pause'].includes(mode) ? null : config.target,
      rollout: { basisPoints: 0, salt: 'local-acceptance', testCodeHashes: [digest(config.testCode)] }
    }
    const envelope = {
      format: config.envelopeFormat,
      kind: 'policy',
      keyId: config.keyId,
      payload: Buffer.from(JSON.stringify(policy)).toString('base64url'),
      signature: ''
    }
    // Same exact-byte signing protocol as scripts/hotpatch/sign.ts.
    const signing = Buffer.from(`${envelope.format}\n${envelope.kind}\n${envelope.keyId}\n${envelope.payload}`)
    envelope.signature = crypto
      .sign(null, signing, fs.readFileSync(path.join(operator, 'signing-key.pem')))
      .toString('base64url')
    if (mode === 'bad-signature')
      envelope.signature = (envelope.signature[0] === 'A' ? 'B' : 'A') + envelope.signature.slice(1)
    writeAtomic('sequence.json', JSON.stringify(policy.policySequence))
    writeAtomic('policy.json', JSON.stringify(envelope))
    process.stdout.write(`Published ${mode}, sequence=${policy.policySequence}. Test code: ${config.testCode}\n`)
  } finally {
    fs.closeSync(fd)
    fs.unlinkSync(lock)
  }
}

function serve() {
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(operator, 'tls-key.pem')),
      cert: fs.readFileSync(path.join(operator, 'tls-cert.pem'))
    },
    (req, res) => {
      const url = new URL(req.url, config.origin)
      res.setHeader('Cache-Control', 'no-store')
      res.on('finish', () =>
        fs.appendFileSync(
          path.join(root, 'requests.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), path: url.pathname, status: res.statusCode }) + '\n'
        )
      )
      const send = (code, body) => {
        res.writeHead(code)
        res.end(body)
      }
      if (url.pathname === '/health' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json')
        return send(200, JSON.stringify({ base: config.base.baseBuildId }))
      }
      if (url.pathname === '/stop' && req.method === 'POST' && req.headers['x-local-control'] === config.controlToken) {
        send(200, JSON.stringify({ stopped: true }))
        server.close(() => process.exit(0))
        return
      }
      if (req.method !== 'GET') return send(405)
      if (url.pathname === '/policy') {
        if (url.searchParams.get('base') !== config.base.baseBuildId) return send(204)
        const filename = path.join(operator, 'policy.json')
        if (!fs.existsSync(filename)) return send(204)
        res.setHeader('Content-Type', 'application/json')
        return send(200, fs.readFileSync(filename))
      }
      const filename = { '/patches/manifest.json': 'manifest.json', '/patches/snapshot.zip': 'snapshot.zip' }[
        url.pathname
      ]
      if (!filename) return send(404)
      res.setHeader('Content-Type', filename.endsWith('.zip') ? 'application/zip' : 'application/json')
      fs.createReadStream(path.join(root, 'patch', filename))
        .on('error', () => res.destroy())
        .pipe(res)
    }
  )
  server.on('error', (error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
  server.listen(config.port, '127.0.0.1', () =>
    process.stdout.write(`Local acceptance HTTPS ready on loopback; pid=${process.pid}\n`)
  )
}

async function main() {
  const command = process.argv[2]
  if (command === 'serve') return serve()
  if (command === 'stop') {
    await request('/stop', 'POST')
    process.stdout.write('Local acceptance HTTPS stopped.\n')
    return
  }
  if (['offer', 'pause', 'rollback', 'bad-signature'].includes(command)) {
    publish(command)
    await startServer()
    return
  }
  if (command !== 'start') throw new Error('Use start, offer, pause, rollback, bad-signature or stop')
  await startServer()
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(path.join(root, config.executable), [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env
  })
  child.unref()
  process.stdout.write(`Started isolated test client. Test code: ${config.testCode}\n`)
}

if (require.main === module)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
module.exports = { publish, startServer, request }
