// No paid endpoint: a local OpenAI-compatible SSE server exercises the native
// loop, filesystem tool, streaming bridge, persisted resume, and cancellation.
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const readline = require('node:readline')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')

async function smoke() {
  const root = path.resolve(__dirname, '..')
  const taskRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-dsh-smoke-'))
  const workspace = path.join(taskRoot, 'workspace')
  await fs.mkdir(workspace)
  const home = path.join(taskRoot, 'home')
  await fs.mkdir(home)
  const skillRoot = path.join(taskRoot, 'skills')
  await fs.mkdir(path.join(skillRoot, 'local-smoke'), { recursive: true })
  await fs.writeFile(
    path.join(skillRoot, 'local-smoke', 'SKILL.md'),
    '---\nname: local-smoke\ndescription: Local no-network smoke capability\n---\nUse only the local mock.\n'
  )
  let requests = 0
  let mcpCalls = 0
  let sawImage = false
  const nativeEvents = []
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(405)
      res.end()
      return
    }
    let body = ''
    for await (const chunk of req) body += chunk
    const input = JSON.parse(body)
    if (process.env.ZEN_DSH_SMOKE_VERBOSE) process.stderr.write(`DSH mock: ${req.url} ${input.method || 'model'}\n`)
    if (req.url === '/mcp') {
      const reply = (result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }))
      }
      if (input.method === 'initialize')
        reply({
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'zen-mock-mcp', version: '1' }
        })
      else if (input.method === 'tools/list')
        reply({
          tools: [
            {
              name: 'deliver',
              description: 'Deliver the local smoke file',
              inputSchema: { type: 'object', properties: {} }
            }
          ]
        })
      else if (input.method === 'tools/call') {
        mcpCalls++
        reply({
          content: [{ type: 'text', text: 'Local MCP file delivered' }],
          structuredContent: { file_path: path.join(workspace, 'smoke.txt') }
        })
      } else if (input.id !== undefined) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, error: { code: -32601, message: 'Method not found' } }))
      } else {
        res.writeHead(202)
        res.end()
      }
      return
    }
    requests++
    sawImage ||= input.messages.some(
      (message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')
    )
    let userIndex = input.messages.findLastIndex(
      (message) =>
        message.role === 'user' &&
        /TOOL_SMOKE|APPROVAL_SMOKE|MCP_SMOKE|EXTERNAL_SMOKE|SPAWN_SLOW_CHILD|CHILD_OUTSIDE_APPROVAL|WAIT_CHILD_STREAM|CANCEL_SMOKE/.test(
          JSON.stringify(message.content)
        )
    )
    if (userIndex < 0) userIndex = input.messages.findLastIndex((message) => message.role === 'user')
    const user = JSON.stringify(input.messages[userIndex]?.content)
    if (process.env.ZEN_DSH_SMOKE_VERBOSE) process.stderr.write(`DSH mock user: ${user.slice(0, 300)}\n`)
    const hasResult = input.messages.slice(userIndex + 1).some((message) => message.role === 'tool')
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const event = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', model: 'zen-mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      )
    event({ role: 'assistant', content: '' })
    if (user.includes('CANCEL_SMOKE') || user.includes('WAIT_CHILD_STREAM')) {
      event({ content: 'waiting' })
      const timer = setTimeout(() => res.end(), 20000)
      res.on('close', () => clearTimeout(timer))
      return
    }
    let tool
    if (!hasResult && user.includes('TOOL_SMOKE'))
      tool = {
        id: 'native-write',
        name: 'write',
        arguments: JSON.stringify({ file_path: path.join(workspace, 'smoke.txt'), content: 'real native file' })
      }
    if (!hasResult && user.includes('APPROVAL_SMOKE'))
      tool = {
        id: 'outside-write',
        name: 'write',
        arguments: JSON.stringify({
          file_path: path.join(taskRoot, 'outside.txt'),
          content: 'must never be written',
          sandbox_permissions: 'danger-full-access',
          justification: 'Exercise the local smoke approval boundary.'
        })
      }
    if (!hasResult && user.includes('MCP_SMOKE'))
      tool = { id: 'mcp-delivery', name: 'mcp__assistant__deliver', arguments: '{}' }
    if (!hasResult && user.includes('EXTERNAL_SMOKE'))
      tool = { id: 'external-delivery', name: 'mcp__external_selected__deliver', arguments: '{}' }
    if (!hasResult && user.includes('CHILD_APPROVAL_SMOKE'))
      tool = {
        id: 'spawn-approval',
        name: 'subagent',
        arguments: JSON.stringify({ description: 'Check child permission', prompt: 'CHILD_OUTSIDE_APPROVAL' })
      }
    if (!hasResult && user.includes('CHILD_OUTSIDE_APPROVAL'))
      tool = {
        id: 'child-outside-write',
        name: 'write',
        arguments: JSON.stringify({
          file_path: path.join(taskRoot, 'child-outside.txt'),
          content: 'must not be written',
          sandbox_permissions: 'danger-full-access',
          justification: 'Validate child approval routing.'
        })
      }
    if (!hasResult && user.includes('SPAWN_SLOW_CHILD'))
      tool = {
        id: 'spawn-cancel',
        name: 'subagent',
        arguments: JSON.stringify({ description: 'Wait for cancellation', prompt: 'WAIT_CHILD_STREAM' })
      }
    if (tool) {
      event({
        tool_calls: [
          { index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }
        ]
      })
      event({}, 'tool_calls')
      res.end('data: [DONE]\n\n')
      return
    }
    event({ content: 'DSH native ' })
    event({ content: 'smoke passed.' })
    event({}, 'stop')
    res.write(
      `data: ${JSON.stringify({ id: 'mock-completion', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`
    )
    res.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  let child
  const pending = new Map()
  let counter = 0
  let stderr = ''
  function call(method, params = {}) {
    if (process.env.ZEN_DSH_SMOKE_VERBOSE) process.stderr.write(`DSH smoke: ${method} ${params.text || ''}\n`)
    const id = ++counter
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new Error(
            `Timed out: ${method}; last events ${nativeEvents
              .slice(-5)
              .map((frame) => `${frame.method}:${frame.params.event?.type || ''}`)
              .join(',')}; ${stderr.slice(-3000)}`
          )
        )
      }, 60000)
      pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  async function launch(resume, overrides = {}) {
    stderr = ''
    const activeHome = overrides.home || home
    await fs.mkdir(activeHome, { recursive: true })
    child = spawn(
      process.execPath,
      [path.join(root, 'resources/dsh-runtime/bridge.mjs'), path.join(root, 'resources/dsh-runtime')],
      {
        cwd: workspace,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          WINDIR: process.env.WINDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          ELECTRON_RUN_AS_NODE: '1',
          HOME: activeHome,
          USERPROFILE: activeHome,
          DSH_HOME: activeHome,
          DSH_AGENTS_HOME: path.join(activeHome, 'agents'),
          DSH_TELEMETRY_DISABLED: '1'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        return
      }
      if (frame.method) {
        nativeEvents.push(frame)
        if (
          process.env.ZEN_DSH_SMOKE_VERBOSE &&
          frame.method === 'session.event' &&
          ['tool/call', 'tool/result'].includes(frame.params.event.type)
        )
          process.stderr.write(
            `DSH native: ${frame.params.sessionId} ${JSON.stringify(frame.params.event).slice(0, 2000)}\n`
          )
        if (frame.id)
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { outcome: 'rejected' } })}\n`)
      } else {
        const request = pending.get(frame.id)
        pending.delete(frame.id)
        if (frame.error) request?.reject(new Error(`${frame.error.message}; ${stderr.slice(-5000)}`))
        else request?.resolve(frame.result)
      }
    })
    const launchedChild = child
    child.on('exit', (code) => {
      if (child !== launchedChild) return
      for (const request of pending.values())
        request.reject(new Error(`DSH child exited ${code} during ${request.method}; ${stderr.slice(-5000)}`))
      pending.clear()
    })
    await call('initialize', {
      sessionId: overrides.sessionId || 'zen-smoke',
      cwd: workspace,
      resume,
      provider: {
        api: 'openai-completions',
        baseURL: `http://127.0.0.1:${port}/v1`,
        model: 'zen-mock',
        apiKey: 'mock-only',
        contextWindow: 32000,
        maxTokens: 4000
      },
      skillRoots: [skillRoot],
      approveToolPrefixes: ['mcp__external_selected__'],
      mcp: ['assistant', 'external_selected'].map((serverName) => ({
        transport: 'streamable-http',
        serverName,
        url: `http://127.0.0.1:${port}/mcp`,
        headers: {},
        toolCallTimeoutMs: 10000,
        failOnStartupError: true
      })),
      ...(overrides.seed ? { seed: overrides.seed } : {})
    })
  }
  try {
    await launch(false)
    assert.equal(requests, 0, 'Initialization must not call any model')
    assert(
      (await call('session/skills')).some((skill) => skill.name === 'local-smoke'),
      'Selected external SKILL.md is discovered natively'
    )
    const image = await require('sharp')({
      create: { width: 2, height: 2, channels: 3, background: { r: 50, g: 80, b: 120 } }
    })
      .png()
      .toBuffer()
    await call('session/prompt', {
      text: 'Reply to the local smoke test.',
      images: [
        {
          media_type: 'image/png',
          data: image.toString('base64')
        }
      ]
    })
    await call('session/wait')
    const history = await call('session/history')
    assert(history.events.some((event) => event.type === 'assistant/message'))
    assert(sawImage, 'Native image attachment reaches the mock provider')
    assert(
      nativeEvents.some(
        (event) => event.method === 'assistant.stream' && event.params.frame.chunk?.type === 'text-delta'
      )
    )
    await call('shutdown')
    await launch(true)
    const resumed = await call('session/history')
    assert(resumed.events.length >= history.events.length, 'Native history survives restart')
    await call('session/prompt', { text: 'TOOL_SMOKE' })
    await call('session/wait')
    assert.equal(await fs.readFile(path.join(workspace, 'smoke.txt'), 'utf8'), 'real native file')
    await call('session/prompt', { text: 'APPROVAL_SMOKE' })
    await call('session/wait')
    assert(
      nativeEvents.some((frame) => frame.method === 'approval/request'),
      'Native sandbox escalation reaches the host'
    )
    assert.equal(
      await fs.stat(path.join(taskRoot, 'outside.txt')).catch(() => undefined),
      undefined,
      'Rejected permission causes no file mutation'
    )
    await call('session/prompt', { text: 'MCP_SMOKE' })
    await call('session/wait')
    assert.equal(mcpCalls, 1)
    assert(
      nativeEvents.some(
        (frame) =>
          frame.method === 'tool.output' && frame.params.value?.structuredContent?.file_path?.endsWith('smoke.txt')
      ),
      'MCP structured file output survives the bridge'
    )
    const fullHistory = await call('session/history')
    await call('session/prompt', { text: 'EXTERNAL_SMOKE' })
    await call('session/wait')
    assert(
      nativeEvents.some(
        (frame) => frame.method === 'approval/request' && frame.params.toolName === 'mcp__external_selected__deliver'
      ),
      'Selected external MCP requires host approval'
    )
    assert.equal(mcpCalls, 1, 'Rejected external MCP is never dispatched')
    await call('session/prompt', { text: 'CHILD_APPROVAL_SMOKE' })
    await call('session/wait')
    assert(
      nativeEvents.some(
        (frame) =>
          frame.method === 'session.event' &&
          frame.params.sessionId !== 'zen-smoke' &&
          frame.params.event.type === 'tool/result' &&
          frame.params.event.data.message.toolCallId === 'child-outside-write' &&
          frame.params.event.data.message.isError
      ),
      'Native delegated child cannot widen its fixed permission scope'
    )
    const rootApproval = nativeEvents.find(
      (frame) => frame.method === 'approval/request' && frame.params.callId === 'outside-write'
    )
    assert.equal(
      rootApproval.params.toolInput.file_path,
      path.join(taskRoot, 'outside.txt'),
      'Root approval includes the real native tool arguments'
    )
    assert.equal(await fs.stat(path.join(taskRoot, 'child-outside.txt')).catch(() => undefined), undefined)
    await call('session/prompt', { text: 'SPAWN_SLOW_CHILD' })
    const waitingChildUntil = Date.now() + 15000
    while (
      !nativeEvents.some(
        (frame) =>
          frame.method === 'assistant.stream' &&
          frame.params.sessionId !== 'zen-smoke' &&
          frame.params.frame.chunk?.text === 'waiting'
      ) &&
      Date.now() < waitingChildUntil
    )
      await new Promise((resolve) => setTimeout(resolve, 50))
    assert(
      nativeEvents.some(
        (frame) =>
          frame.method === 'assistant.stream' &&
          frame.params.sessionId !== 'zen-smoke' &&
          frame.params.frame.chunk?.text === 'waiting'
      ),
      'Real child model stream is running before cancellation'
    )
    const cancelledAt = Date.now()
    await call('session/cancel')
    await call('session/wait')
    assert(Date.now() - cancelledAt < 10000, 'Root cancellation drains its background child promptly')
    await call('shutdown')
    const forkHome = path.join(taskRoot, 'fork')
    await fs.mkdir(forkHome)
    await fs.cp(path.join(home, 'attachments'), path.join(forkHome, 'attachments'), { recursive: true })
    const beforeReplay = requests
    await launch(false, { sessionId: 'zen-fork', home: forkHome, seed: fullHistory.events })
    assert.equal(requests, beforeReplay, 'History seeding never replays a model request or a tool')
    assert.equal(mcpCalls, 1, 'History seeding never repeats an MCP side effect')
    assert((await call('session/history')).events.some((event) => event.type === 'tool/result'))
    await call('session/prompt', { text: 'CANCEL_SMOKE' })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const messageId = 'zen-input-1234567890abcdef1234567890abcdef'
    await call('session/steer', { text: 'Native steering once', messageId })
    await call('session/steer', { text: 'Native steering once', messageId })
    await call('session/cancel')
    await call('session/wait')
    const cancelled = await call('session/history')
    assert(cancelled.events.some((event) => event.type === 'turn/end' && event.data.reason.kind === 'aborted'))
    assert.equal(
      cancelled.events.filter(
        (event) =>
          event.type === 'agent/inbox/spliced' && event.data.inserted.some((message) => message.id === messageId)
      ).length,
      1,
      'Repeated steering identity is admitted once'
    )
    await call('shutdown')
    process.stdout.write(
      JSON.stringify({ ok: true, requests, mcpCalls, sawImage, nativeEvents: nativeEvents.length, taskRoot }) + '\n'
    )
  } finally {
    child?.kill()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

smoke().catch((error) => {
  process.stderr.write(error.stack + '\n')
  process.exitCode = 1
})
