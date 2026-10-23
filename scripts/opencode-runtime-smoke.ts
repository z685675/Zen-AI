// Local, cost-free smoke test. No user Provider, credential or upstream is used.
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { listenOnLoopback } from '../packages/shared/utils/loopbackServer'
import { applyAutomationProfile, LIGHTWEIGHT_TOOLS } from '../src/main/services/agents/services/automation/profile'
import { OpenCodeClient } from '../src/main/services/agents/services/opencode/client'
import {
  buildOpenCodeConfig,
  buildOpenCodeEnvironment,
  OPENCODE_VERSION
} from '../src/main/services/agents/services/opencode/config'
import { createOpenCodeGateway } from '../src/main/services/agents/services/opencode/gateway'
import { prepareOpenCodeOfflineConfig } from '../src/main/services/agents/services/opencode/offline'

async function main() {
  const lightweight = process.argv[2] === '--lightweight'
  const permissions = process.argv[2] === '--permissions'
  const packagedResources = process.argv[2] && !lightweight && !permissions ? path.resolve(process.argv[2]) : undefined
  if (process.argv.length > 3) throw new Error('Usage: pnpm smoke:opencode [packaged-resources-directory]')
  const require = createRequire(__filename)
  const wrapperRequire = createRequire(require.resolve('opencode-ai/package.json'))
  const target = `opencode-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}${process.arch === 'x64' ? '-baseline' : ''}`
  const binary = packagedResources
    ? path.join(
        packagedResources,
        'opencode',
        `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`,
        process.platform === 'win32' ? 'opencode.exe' : 'opencode'
      )
    : path.join(
        path.dirname(wrapperRequire.resolve(`${target}/package.json`)),
        'bin',
        process.platform === 'win32' ? 'opencode.exe' : 'opencode'
      )
  const root = await mkdtemp(path.join(os.tmpdir(), 'Zen OpenCode 本地测试 '))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort('smoke timeout'), 90_000)
  let requests = 0
  let auditTurn = 0
  const requestAudits: Array<{ source: string | string[] | undefined; task: string | string[] | undefined }> = []
  let sawLegacyBackground = false
  const lightweightInventories: string[][] = []
  let lightweightToolCalls = 0
  const mcpEntries: Array<{ server: Server; transport: StreamableHTTPServerTransport }> = []
  const mcpSessions = new Map<string, (typeof mcpEntries)[number]>()
  const mcpInitialized = new Set<string>()
  const usedModels = new Set<string>()
  const gateway = createServer(async (req, res) => {
    const mcpRoute = req.url?.match(/^\/v1\/(assistant|browser)\/[^/]+\/mcp$/)?.[1]
    if (mcpRoute) {
      if (req.headers.authorization !== 'Bearer local-placeholder') {
        res.writeHead(401).end()
        return
      }
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      let entry = sessionId ? mcpSessions.get(sessionId) : undefined
      if (!entry) {
        const server = new Server({ name: `zen-smoke-${mcpRoute}`, version: '1.0.0' }, { capabilities: { tools: {} } })
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: lightweight
            ? LIGHTWEIGHT_TOOLS.map((name) => ({
                name,
                description: 'Controlled local fixture',
                inputSchema: { type: 'object', properties: {} }
              }))
            : [
                {
                  name: 'ping',
                  description: 'Local cost-free MCP fixture',
                  inputSchema: { type: 'object', properties: {} }
                }
              ]
        }))
        server.setRequestHandler(CallToolRequestSchema, async () => {
          if (lightweight) {
            lightweightToolCalls++
            await writeFile(path.join(root, 'workspace', 'lightweight.txt'), 'controlled local output')
          }
          return { content: [{ type: 'text', text: 'local MCP fixture' }] }
        })
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => {
            mcpSessions.set(id, { server, transport })
            mcpInitialized.add(mcpRoute)
          }
        })
        entry = { server, transport }
        mcpEntries.push(entry)
        await server.connect(transport)
      }
      const data: Buffer[] = []
      if (req.method === 'POST') for await (const chunk of req) data.push(chunk)
      await entry.transport.handleRequest(
        req,
        res,
        data.length ? JSON.parse(Buffer.concat(data).toString()) : undefined
      )
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests++
    requestAudits.push({ source: req.headers.originator, task: req.headers['x-zen-task-id'] })
    sawLegacyBackground ||= JSON.stringify(body.messages).includes('ZEN_LEGACY_BACKGROUND purple')
    usedModels.add(body.model)
    if (lightweight)
      lightweightInventories.push((body.tools || []).map((tool: any) => tool.function?.name || tool.name))
    const latestUser = body.messages.findLast((message: any) => message.role === 'user')
    if (JSON.stringify(latestUser).includes('WAIT_FOR_CANCEL')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.flushHeaders()
      return
    }
    const compaction = JSON.stringify(body.messages).includes('context summarization agent')
    const hasToolResult = body.messages.some((message: any) => message.role === 'tool')
    const toolsRequested = body.messages.some(
      (message: any) =>
        typeof message.content === 'string' && /CREATE_SMOKE_FILE|CREATE_LIGHTWEIGHT_OUTPUT/.test(message.content)
    )
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const delta =
      toolsRequested && !hasToolResult && !compaction
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'call_smoke',
                type: 'function',
                function: {
                  name: lightweight
                    ? body.tools.find((tool: any) => tool.function?.name?.endsWith('__create_file')).function.name
                    : 'write',
                  arguments: JSON.stringify({
                    filePath: path.join(root, 'workspace', 'result.txt'),
                    content: 'verified local tool execution'
                  })
                }
              }
            ]
          }
        : { content: 'local mock reply' }
    res.write(
      `data: ${JSON.stringify({ id: 'chatcmpl_smoke', object: 'chat.completion.chunk', created: 1, model: 'zen-smoke', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    )
    res.write(
      `data: ${JSON.stringify({ id: 'chatcmpl_smoke', object: 'chat.completion.chunk', created: 1, model: 'zen-smoke', choices: [{ index: 0, delta: {}, finish_reason: toolsRequested && !hasToolResult ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 20, total_tokens: 2020 } })}\n\n`
    )
    res.end('data: [DONE]\n\n')
  })
  const gatewayPort = await listenOnLoopback(gateway)
  await mkdir(path.join(root, 'workspace'), { recursive: true })
  await mkdir(path.join(root, 'skill'), { recursive: true })
  await writeFile(
    path.join(root, 'skill', 'SKILL.md'),
    '---\nname: zen-smoke\ndescription: Cost-free integration test skill\n---\nUse the local mock transport only.\n'
  )
  const smokeSession = {
    id: 'zen-local-smoke',
    accessible_paths: [path.join(root, 'workspace')],
    configuration: { permission_mode: permissions ? 'default' : 'bypassPermissions' }
  } as any
  const config = buildOpenCodeConfig({
    session: lightweight
      ? applyAutomationProfile(smokeSession, { kind: 'wechat', workspace: path.join(root, 'workspace') })
      : smokeSession,
    provider: {
      id: 'local',
      type: 'new-api',
      apiHost: `http://127.0.0.1:${gatewayPort}/v1`,
      apiKey: 'local-placeholder',
      models: [{ id: 'zen-smoke', name: 'Local smoke' }]
    } as any,
    modelId: 'zen-smoke',
    skillPaths: [path.join(root, 'skill')],
    api: { host: '127.0.0.1', port: gatewayPort, apiKey: 'local-placeholder' }
  })
  config.provider['zen-selected'].models['zen-smoke-2'] = {
    ...config.provider['zen-selected'].models['zen-smoke'],
    id: 'zen-smoke-2',
    name: 'Second mock model'
  }
  const toolBinDir = path.join(root, 'tools')
  const env = buildOpenCodeEnvironment(process.env, root, 'smoke-local-password', toolBinDir)
  const transportEvents: string[] = []
  const transport = await createOpenCodeGateway(config.provider['zen-selected'].options.baseURL, (_id, event) =>
    transportEvents.push(event)
  )
  transport.setOperation('local-smoke-operation')
  config.provider['zen-selected'].options.baseURL = transport.baseURL
  config.provider['zen-selected'].options.headers['x-zen-runtime-token'] = transport.token
  try {
    await prepareOpenCodeOfflineConfig(
      root,
      packagedResources
        ? path.join(packagedResources, 'opencode-runtime')
        : path.resolve(__dirname, '../resources/opencode-runtime')
    )
  } catch (error) {
    clearTimeout(timeout)
    transport.stop()
    gateway.closeAllConnections()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    throw error
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)
  const nativeStartedAt = performance.now()
  const child = spawn(
    binary,
    ['serve', '--hostname=127.0.0.1', '--port=0', '--no-mdns', '--pure', '--log-level=WARN'],
    { cwd: path.join(root, 'workspace'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stderr.on('data', () => {})
  let client: OpenCodeClient | undefined
  try {
    const address = await new Promise<string>((resolve, reject) => {
      let stdout = ''
      child.stdout.on('data', (data) => {
        stdout += data
        const match = stdout.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
        if (match) resolve(match[1])
      })
      child.once('error', reject)
      child.once('exit', (code) => reject(new Error(`Native smoke process exited ${code}`)))
      controller.signal.addEventListener('abort', () => reject(new Error('Native startup timeout')), { once: true })
    })
    client = new OpenCodeClient(address, 'smoke-local-password', path.join(root, 'workspace'))
    const health = await client.request<any>('/global/health', 'GET', undefined, controller.signal)
    if (!health.healthy || health.version !== OPENCODE_VERSION) throw new Error('Health/version mismatch')
    const startupMs = Math.round(performance.now() - nativeStartedAt)
    const effective = await client.request<any>('/config', 'GET', undefined, controller.signal)
    for (const key of ['provider', 'mcp', 'permission', 'skills', 'enabled_providers', 'plugin']) {
      if (!isDeepStrictEqual(effective[key], JSON.parse(JSON.stringify(config))[key])) {
        console.log(
          'CONFIG SHAPE MISMATCH',
          key,
          Object.keys(effective[key] || {}),
          Object.keys((config as any)[key] || {})
        )
        throw new Error(`Effective config mismatch: ${key}`)
      }
    }
    const skills = await client.request<any[]>('/skill', 'GET', undefined, controller.signal)
    if (lightweight) {
      if (skills.some((skill) => skill.location !== '<built-in>'))
        throw new Error('Lightweight native runtime discovered external skills')
      const session = await client.request<{ id: string }>(
        '/session',
        'POST',
        { title: 'Lightweight mock' },
        controller.signal
      )
      await client.request(
        `/session/${session.id}/message`,
        'POST',
        {
          model: { providerID: 'zen-selected', modelID: 'zen-smoke' },
          parts: [{ type: 'text', text: 'CREATE_LIGHTWEIGHT_OUTPUT' }]
        },
        controller.signal
      )
      if (
        !lightweightToolCalls ||
        (await readFile(path.join(root, 'workspace', 'lightweight.txt'), 'utf8')) !== 'controlled local output'
      )
        throw new Error('Controlled tool was not executed by native runtime')
      const allowed = new Set(LIGHTWEIGHT_TOOLS.map((name) => `mcp__assistant__${name}`))
      if (
        !lightweightInventories.length ||
        lightweightInventories.some((tools) => !tools.length || tools.some((tool) => !allowed.has(tool as any)))
      )
        throw new Error(`Unexpected native lightweight tool inventory: ${JSON.stringify(lightweightInventories)}`)
      process.stdout.write(
        `PASS lightweight native profile: controlled MCP execution, no terminal/browser/skills exposed; ${requests} local mock requests, zero paid requests.\n`
      )
      return
    }
    const smokeSkill = skills.find((skill) => skill.name === 'zen-smoke')
    if (!smokeSkill) throw new Error('Explicit enabled Skill folder not discovered')
    if (
      typeof smokeSkill.location !== 'string' ||
      path.resolve(smokeSkill.location) !== path.join(root, 'skill', 'SKILL.md')
    )
      throw new Error('Native Skill inventory did not report its actual definition path')
    if (requests !== 0) throw new Error('Read-only native Skill inventory unexpectedly called a model')
    if (permissions) {
      const session = await client.request<{ id: string }>(
        '/session',
        'POST',
        { title: 'Native approval' },
        controller.signal
      )
      const events = client.events(controller.signal)
      await events.next()
      const submit = client.request(
        `/session/${session.id}/prompt_async`,
        'POST',
        {
          agent: 'build',
          model: { providerID: 'zen-selected', modelID: 'zen-smoke' },
          parts: [{ type: 'text', text: 'CREATE_SMOKE_FILE' }]
        },
        controller.signal
      )
      let approved = false
      let output = false
      for await (const event of events) {
        const props = event.properties
        if (
          props.sessionID !== session.id &&
          props.info?.sessionID !== session.id &&
          props.part?.sessionID !== session.id
        )
          continue
        if (event.type === 'session.error') throw new Error('Native approval fixture failed')
        if (event.type === 'permission.asked') {
          if (
            props.permission !== 'edit' ||
            path.resolve(props.metadata.filepath) !== path.join(root, 'workspace', 'result.txt') ||
            !props.tool?.callID
          )
            throw new Error('Unexpected native approval request')
          await client.request(`/permission/${props.id}/reply`, 'POST', { reply: 'once' }, controller.signal)
          approved = true
        }
        if (
          event.type === 'message.part.updated' &&
          props.part.type === 'text' &&
          props.part.text?.includes('local mock reply')
        )
          output = true
        if (approved && output && event.type === 'session.status' && props.status.type === 'idle') break
      }
      await submit
      if (
        !approved ||
        !output ||
        (await readFile(path.join(root, 'workspace', 'result.txt'), 'utf8')) !== 'verified local tool execution'
      )
        throw new Error('Native one-time write approval did not complete')
      process.stdout.write(
        'PASS native edit approval: linked tool ID, one-time reply and actual file output; zero paid requests.\n'
      )
      return
    }
    // Simulate background installation completing after the native process
    // has started. No system installation, Git or model request is involved.
    await mkdir(toolBinDir, { recursive: true })
    await writeFile(
      path.join(toolBinDir, process.platform === 'win32' ? 'zen-smoke-tool.cmd' : 'zen-smoke-tool'),
      process.platform === 'win32'
        ? '@echo off\r\necho ZEN_PRIVATE_TOOL_READY\r\n'
        : '#!/bin/sh\nprintf ZEN_PRIVATE_TOOL_READY',
      { mode: 0o755 }
    )
    const toolSession = await client.request<{ id: string }>(
      '/session',
      'POST',
      { title: 'Tool readiness' },
      controller.signal
    )
    const shellResult = await client.request<any>(
      `/session/${toolSession.id}/shell`,
      'POST',
      { agent: 'build', model: { providerID: 'zen-selected', modelID: 'zen-smoke' }, command: 'zen-smoke-tool' },
      controller.signal
    )
    if (
      !shellResult.parts.some(
        (part: any) => part.type === 'tool' && part.state?.output?.includes('ZEN_PRIVATE_TOOL_READY')
      )
    )
      throw new Error('Native shell cannot find a tool prepared in the background')
    if (requests !== 0) throw new Error('Local tool readiness unexpectedly called a model')
    process.stdout.write(
      'PASS background tool readiness: an already-running native shell can use the private tool directory.\n'
    )
    const session = await client.request<{ id: string }>(
      '/session',
      'POST',
      { title: 'Local smoke' },
      controller.signal
    )
    await client.request(
      `/session/${session.id}/message`,
      'POST',
      {
        messageID: `msg_${(BigInt(Date.now()) * 4096n).toString(16).padStart(12, '0')}${randomBytes(7).toString('hex')}`,
        noReply: true,
        model: { providerID: 'zen-selected', modelID: 'zen-smoke' },
        parts: [
          {
            type: 'text',
            text: 'Historical data only. Do not replay tools. ZEN_LEGACY_BACKGROUND purple',
            synthetic: true
          }
        ]
      },
      controller.signal
    )
    if (requests !== 0) throw new Error('noReply unexpectedly called model')
    const turn = async (text: string, modelID = 'zen-smoke', targetSession = session.id) => {
      const turnStartedAt = performance.now()
      const auditStart = requestAudits.length
      const taskId = `local-smoke-turn-${++auditTurn}`
      transport.setOperation(taskId)
      const eventsController = new AbortController()
      const iterator = client!.events(AbortSignal.any([controller.signal, eventsController.signal]))
      await iterator.next()
      const submit = client!.request(
        `/session/${targetSession}/prompt_async`,
        'POST',
        { model: { providerID: 'zen-selected', modelID }, parts: [{ type: 'text', text }] },
        controller.signal
      )
      let busy = false,
        output = false
      try {
        for await (const event of iterator) {
          if (
            event.properties.sessionID !== targetSession &&
            event.properties.info?.sessionID !== targetSession &&
            event.properties.part?.sessionID !== targetSession
          )
            continue
          if (event.type === 'session.error')
            throw new Error(`Native turn error: ${JSON.stringify(event.properties.error)}`)
          if (event.type === 'session.status' && event.properties.status.type === 'busy') busy = true
          if (
            event.type === 'message.part.updated' &&
            event.properties.part.type === 'text' &&
            event.properties.part.text.includes('local mock reply')
          )
            output = true
          if (busy && event.type === 'session.status' && event.properties.status.type === 'idle') break
        }
        await submit
        if (!output) throw new Error('Missing native model output')
        const audits = requestAudits.slice(auditStart)
        if (!audits.length || audits.some((audit) => audit.source !== 'zenai_opencode' || audit.task !== taskId))
          throw new Error('Native model requests lost their Open Code source or per-turn task marker')
      } finally {
        eventsController.abort()
      }
      return Math.round(performance.now() - turnStartedAt)
    }
    const coldTurnMs = await turn('hello')
    if (!sawLegacyBackground) throw new Error('Synthetic continuation background missing from the next model request')
    process.stdout.write(
      'PASS legacy background: no model call during copying; next new turn includes the saved background.\n'
    )
    if (!mcpInitialized.has('assistant') || !mcpInitialized.has('browser'))
      throw new Error('Both configured MCP servers must connect during the first turn')
    const mcpStatus = await client.request<Record<string, { status: string }>>(
      '/mcp',
      'GET',
      undefined,
      controller.signal
    )
    if (Object.values(mcpStatus).some((value) => value.status !== 'connected') || Object.keys(mcpStatus).length !== 2)
      throw new Error('Native MCP discovery did not finish successfully')
    await turn('CREATE_SMOKE_FILE')
    if ((await readFile(path.join(root, 'workspace', 'result.txt'), 'utf8')) !== 'verified local tool execution')
      throw new Error('Native tool file verification failed')
    const history = await client.request<any[]>(`/session/${session.id}/message`, 'GET', undefined, controller.signal)
    if (history.filter((item) => item.info.role === 'user').length !== 3)
      throw new Error('Native history continuity failed')
    await client.request(
      `/session/${session.id}/summarize`,
      'POST',
      { providerID: 'zen-selected', modelID: 'zen-smoke' },
      controller.signal
    )
    const compacted = await client.request<any[]>(`/session/${session.id}/message`, 'GET', undefined, controller.signal)
    if (
      !compacted.some(
        (item) =>
          item.info.summary &&
          item.parts.some((part: any) => part.type === 'text' && part.text.includes('local mock reply'))
      )
    )
      throw new Error('Native compaction checkpoint missing')
    await turn('hello after compaction', 'zen-smoke-2')
    if (!usedModels.has('zen-smoke-2')) throw new Error('Native model switch did not use the requested model')
    const cancelEvents = new AbortController()
    const cancelIterator = client.events(AbortSignal.any([cancelEvents.signal, controller.signal]))
    await cancelIterator.next()
    const cancellable = client.request(
      `/session/${session.id}/prompt_async`,
      'POST',
      {
        model: { providerID: 'zen-selected', modelID: 'zen-smoke' },
        parts: [{ type: 'text', text: 'WAIT_FOR_CANCEL' }]
      },
      controller.signal
    )
    for await (const event of cancelIterator) {
      if (
        event.type === 'session.status' &&
        event.properties.sessionID === session.id &&
        event.properties.status.type === 'busy'
      ) {
        await client.request(`/session/${session.id}/abort`, 'POST', undefined, controller.signal)
        cancelEvents.abort()
        break
      }
    }
    await cancellable
    const stopped = await client.request<Record<string, { type: string }>>(
      '/session/status',
      'GET',
      undefined,
      controller.signal
    )
    if (stopped[session.id] && stopped[session.id].type !== 'idle')
      throw new Error('Native cancellation did not settle the session')
    const warmTurnMs = await turn('hello after cancellation')
    const resumedHistory = await client.request<any[]>(
      `/session/${session.id}/message`,
      'GET',
      undefined,
      controller.signal
    )
    if (
      !resumedHistory.some((item) =>
        item.parts.some((part: any) => part.type === 'text' && part.text === 'hello after cancellation')
      ) ||
      !resumedHistory.some((item) => item.parts.some((part: any) => part.type === 'text' && part.text === 'hello'))
    )
      throw new Error('Cancelled session could not continue with its existing history')
    if (!transportEvents.includes('headers-received')) throw new Error('Native request diagnostics were not linked')
    if (requestAudits.some((audit) => audit.source !== 'zenai_opencode' || !audit.task))
      throw new Error('Native compaction or tool requests lost their audit markers')
    process.stdout.write('PASS request audit: Open Code source and stable per-turn task IDs reach the mock API.\n')
    const requestsBeforeHistory = requests
    const boundary = resumedHistory.find(
      (item) => item.info.role === 'user' && item.parts.some((part: any) => part.text === 'CREATE_SMOKE_FILE')
    )
    const branch = await client.request<{ id: string }>(
      `/session/${session.id}/fork`,
      'POST',
      { messageID: boundary.info.id },
      controller.signal
    )
    const branchHistory = await client.request<any[]>(
      `/session/${branch.id}/message`,
      'GET',
      undefined,
      controller.signal
    )
    if (branchHistory.length !== resumedHistory.findIndex((item) => item.info.id === boundary.info.id))
      throw new Error('Native fork cutoff is not exclusive')
    if (!branchHistory.some((item) => item.parts.some((part: any) => part.text === 'hello')))
      throw new Error('Branch lost preceding user history')
    if (branchHistory.some((item) => item.parts.some((part: any) => part.text === 'CREATE_SMOKE_FILE')))
      throw new Error('Branch retained a later user turn')
    const reply = branchHistory.find((item) => item.info.role === 'assistant')
    await client.request(`/session/${branch.id}/message/${reply.info.id}`, 'DELETE', undefined, controller.signal)
    const deletedHistory = await client.request<any[]>(
      `/session/${branch.id}/message`,
      'GET',
      undefined,
      controller.signal
    )
    if (deletedHistory.some((item) => item.info.id === reply.info.id))
      throw new Error('Native delete did not remove the reply')
    const originalHistory = await client.request<any[]>(
      `/session/${session.id}/message`,
      'GET',
      undefined,
      controller.signal
    )
    if (JSON.stringify(originalHistory) !== JSON.stringify(resumedHistory))
      throw new Error('Branch/delete changed original conversation')
    if (requests !== requestsBeforeHistory) throw new Error('History operations unexpectedly called a model')
    await turn('hello in branch after deletion', 'zen-smoke', branch.id)
    const branchContinued = await client.request<any[]>(
      `/session/${branch.id}/message`,
      'GET',
      undefined,
      controller.signal
    )
    if (!branchContinued.some((item) => item.parts.some((part: any) => part.text === 'hello in branch after deletion')))
      throw new Error('Branch could not continue after deletion')
    process.stdout.write(
      'PASS native fork/delete/continuation: original conversation unchanged; history operations made no model calls.\n'
    )
    console.log(
      `PASS OpenCode ${OPENCODE_VERSION}: health/auth/config, both HTTP MCP servers, explicit Skills, noReply, tool file verification, history, native compaction, model switch, cancellation and continuation (${requests} mock requests; zero paid requests; local startup ${startupMs}ms, first mock turn ${coldTurnMs}ms, warm mock turn ${warmTurnMs}ms).`
    )
  } finally {
    clearTimeout(timeout)
    transport.stop()
    controller.abort()
    if (client) await client.request('/global/dispose', 'POST').catch(() => undefined)
    child.kill()
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve()
      else {
        child.once('exit', () => resolve())
        setTimeout(resolve, 5000).unref()
      }
    })
    for (const entry of mcpEntries) {
      await entry.transport.close().catch(() => undefined)
      await entry.server.close().catch(() => undefined)
    }
    gateway.closeAllConnections()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    if (process.env.OPENCODE_SMOKE_KEEP !== '1') {
      if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('Zen OpenCode 本地测试 ')) {
        await rm(root, { recursive: true, force: true })
      } else {
        process.stderr.write('Unexpected smoke cleanup path; temporary files were retained.\n')
        process.exitCode = 1
      }
    } else console.log('Temporary smoke workspace:', root)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
