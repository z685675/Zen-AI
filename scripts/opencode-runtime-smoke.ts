// Local, cost-free smoke test. No user Provider, credential or upstream is used.
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { registerModelCapabilities } from '../packages/shared/modelCapabilities'
import { listenOnLoopback } from '../packages/shared/utils/loopbackServer'
import { applyAutomationProfile, LIGHTWEIGHT_TOOLS } from '../src/main/services/agents/services/automation/profile'
import { OpenCodeClient } from '../src/main/services/agents/services/opencode/client'
import {
  buildOpenCodeConfig,
  buildOpenCodeEnvironment,
  OPENCODE_VERSION
} from '../src/main/services/agents/services/opencode/config'
import { createOpenCodeGateway } from '../src/main/services/agents/services/opencode/gateway'
import { prepareOpenCodeInput } from '../src/main/services/agents/services/opencode/inputMaterial'
import {
  isInvalidReadToolLoop,
  LOOP_SUMMARY_AGENT,
  OpenCodeLoopRecovery
} from '../src/main/services/agents/services/opencode/loopRecovery'
import { prepareOpenCodeOfflineConfig } from '../src/main/services/agents/services/opencode/offline'
import { getOpenCodeTempDirectory } from '../src/main/services/agents/services/opencode/workspace'

async function main() {
  const lightweight = process.argv[2] === '--lightweight'
  const permissions = process.argv[2] === '--permissions'
  const plan = process.argv[2] === '--plan'
  const reasoning = process.argv[2] === '--reasoning'
  const capacity = process.argv[2] === '--capacity'
  const contextRecoveryMode = process.argv[2] === '--context-recovery'
  const completionGuardMode = process.argv[2] === '--completion-guard'
  const invalidLoopRecoveryMode = process.argv[2] === '--invalid-loop-recovery'
  const loopRecoveryMode = process.argv[2] === '--loop-recovery' || invalidLoopRecoveryMode
  const smokeModel = reasoning ? 'gpt-smoke' : 'zen-smoke'
  const packagedResources =
    process.argv[2] &&
    !lightweight &&
    !permissions &&
    !plan &&
    !reasoning &&
    !capacity &&
    !contextRecoveryMode &&
    !loopRecoveryMode &&
    !completionGuardMode
      ? path.resolve(process.argv[2])
      : undefined
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
  let writeTarget: string | undefined
  let auditTurn = 0
  const requestAudits: Array<{ source: string | string[] | undefined; task: string | string[] | undefined }> = []
  let sawLegacyBackground = false
  const lightweightInventories: string[][] = []
  let lightweightToolCalls = 0
  const mcpEntries: Array<{ server: Server; transport: StreamableHTTPServerTransport }> = []
  const mcpSessions = new Map<string, (typeof mcpEntries)[number]>()
  const mcpInitialized = new Set<string>()
  const usedModels = new Set<string>()
  let reasoningVerified = false
  let capacityOutputVerified = false
  let summaryTools: number | undefined
  let sawPdfParserGuard = false
  let contextStage: 'recovery' | 'failure' | 'material' | undefined
  let contextErrors = 0
  let nativeContextErrors = 0
  let materialRead: { filePath: string; count: number; limit: number } | undefined
  let materialVerified = false
  const gateway = createServer(async (req, res) => {
    if (req.url === '/raw-paper.pdf') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('%PDF-1.7 native-fixture-binary-garbage')
      return
    }
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
            : invalidLoopRecoveryMode && mcpRoute === 'assistant'
              ? [
                  {
                    name: 'web_search',
                    description: 'Read-only fixture; query required',
                    inputSchema: {
                      type: 'object',
                      properties: { query: { type: 'string' } },
                      required: ['query']
                    }
                  }
                ]
              : [
                  {
                    name: 'ping',
                    description: 'Local cost-free MCP fixture',
                    inputSchema: { type: 'object', properties: {} }
                  }
                ]
        }))
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          if (invalidLoopRecoveryMode && !request.params.arguments?.query)
            return { isError: true, content: [{ type: 'text', text: 'invalid_input: query is required' }] }
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
    if (capacity && (body.max_tokens ?? body.max_completion_tokens) === 32_000) capacityOutputVerified = true
    requests++
    if (loopRecoveryMode) {
      const finalizing = !body.tools?.length
      if (finalizing) summaryTools = body.tools?.length ?? 0
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // Three identical calls in one generation trigger the native guard.
      // Use a disposable read, never user files or a paid Provider.
      const delta = finalizing
        ? { content: 'Recovered review: verified local research evidence; remaining gaps are explicitly listed.' }
        : {
            tool_calls: Array.from({ length: invalidLoopRecoveryMode ? 4 : 3 }, (_, index) => ({
              index,
              id: `loop_${requests}_${index}`,
              type: 'function',
              function: {
                name: invalidLoopRecoveryMode && index > 0 ? 'mcp__assistant__web_search' : 'read',
                arguments:
                  invalidLoopRecoveryMode && index > 0
                    ? ''
                    : JSON.stringify({ filePath: path.join(root, 'workspace', 'evidence.txt') })
              }
            }))
          }
      if (delta.tool_calls) {
        for (const call of delta.tool_calls) {
          res.write(
            `data: ${JSON.stringify({ id: `loop_${requests}`, object: 'chat.completion.chunk', created: 1, model: smokeModel, choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })}\n\n`
          )
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
      } else
        res.write(
          `data: ${JSON.stringify({ id: `loop_${requests}`, object: 'chat.completion.chunk', created: 1, model: smokeModel, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        )
      res.write(
        `data: ${JSON.stringify({ id: `loop_${requests}`, object: 'chat.completion.chunk', created: 1, model: smokeModel, choices: [{ index: 0, delta: {}, finish_reason: finalizing ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 2000, completion_tokens: 20, total_tokens: 2020 } })}\n\n`
      )
      res.end('data: [DONE]\n\n')
      return
    }
    requestAudits.push({ source: req.headers.originator, task: req.headers['x-zen-task-id'] })
    sawLegacyBackground ||= JSON.stringify(body.messages).includes('ZEN_LEGACY_BACKGROUND purple')
    usedModels.add(body.model)
    if (reasoning && body.model === smokeModel) reasoningVerified ||= body.reasoning_effort === 'high'
    if (lightweight)
      lightweightInventories.push((body.tools || []).map((tool: any) => tool.function?.name || tool.name))
    const latestUserIndex = body.messages.findLastIndex((message: any) => message.role === 'user')
    const latestUser = body.messages[latestUserIndex]
    if (JSON.stringify(latestUser).includes('WAIT_FOR_CANCEL')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.flushHeaders()
      return
    }
    const compaction = JSON.stringify(body.messages).includes('context summarization agent')
    if (contextStage === 'failure' || (contextStage === 'recovery' && contextErrors === 0)) {
      contextErrors++
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: 'maximum context length exceeded',
            type: 'invalid_request_error',
            code: 'context_length_exceeded'
          }
        })
      )
      return
    }
    const forceCompaction = completionGuardMode && !compaction && JSON.stringify(latestUser).includes('COMPACT_NOW')
    const hasToolResult = body.messages.slice(latestUserIndex).some((message: any) => message.role === 'tool')
    if (contextStage === 'material') {
      if (JSON.stringify(body.messages).includes('RAW_LARGE_MATERIAL_'.repeat(100)))
        throw new Error('Huge original text was inlined into the model request')
      if (hasToolResult) {
        materialVerified =
          JSON.stringify(body.messages).includes('END-LARGE-SUBMISSION') &&
          JSON.stringify(body.messages).includes('USER-REQUEST-START')
      } else {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const tool_calls = [1, Math.max(1, materialRead!.count - materialRead!.limit + 1)].map((offset, index) => ({
          index,
          id: `read_material_${index}`,
          type: 'function',
          function: {
            name: 'read',
            arguments: JSON.stringify({ filePath: materialRead!.filePath, offset, limit: materialRead!.limit })
          }
        }))
        res.write(
          `data: ${JSON.stringify({ id: 'material', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls }, finish_reason: null }] })}\n\n`
        )
        res.write(
          `data: ${JSON.stringify({ id: 'material', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2000, completion_tokens: 20, total_tokens: 2020 } })}\n\n`
        )
        res.end('data: [DONE]\n\n')
        return
      }
    }
    if (
      body.messages.some(
        (message: any) => message.role === 'tool' && JSON.stringify(message).includes('pdf_requires_parser')
      )
    ) {
      if (JSON.stringify(body.messages).includes('native-fixture-binary-garbage'))
        throw new Error('Raw PDF reached the model')
      sawPdfParserGuard = true
    }
    const pdfRequested = completionGuardMode && JSON.stringify(latestUser).includes('WEBFETCH_PDF')
    const toolsRequested =
      pdfRequested || /CREATE_SMOKE_FILE|CREATE_LIGHTWEIGHT_OUTPUT/.test(JSON.stringify(latestUser))
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
                  name: pdfRequested
                    ? 'webfetch'
                    : lightweight
                      ? body.tools.find((tool: any) => tool.function?.name?.endsWith('__create_file')).function.name
                      : reasoning
                        ? 'apply_patch'
                        : 'write',
                  arguments: JSON.stringify(
                    pdfRequested
                      ? {
                          url: `http://127.0.0.1:${(gateway.address() as { port: number }).port}/raw-paper.pdf`,
                          format: 'text'
                        }
                      : reasoning
                        ? {
                            patchText: [
                              '*** Begin Patch',
                              `*** Add File: ${path.join(root, 'workspace', 'result.txt')}`,
                              '+verified local tool execution',
                              '*** End Patch'
                            ].join('\n')
                          }
                        : {
                            filePath:
                              writeTarget ??
                              path.join(
                                root,
                                'workspace',
                                JSON.stringify(latestUser).includes('CREATE_SMOKE_FILE_APPROVAL')
                                  ? 'approval.txt'
                                  : 'result.txt'
                              ),
                            content: 'verified local tool execution'
                          }
                  )
                }
              }
            ]
          }
        : { content: 'local mock reply' }
    res.write(
      `data: ${JSON.stringify({ id: 'chatcmpl_smoke', object: 'chat.completion.chunk', created: 1, model: smokeModel, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    )
    res.write(
      `data: ${JSON.stringify({ id: 'chatcmpl_smoke', object: 'chat.completion.chunk', created: 1, model: smokeModel, choices: [{ index: 0, delta: {}, finish_reason: toolsRequested && !hasToolResult && !compaction ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: forceCompaction ? 120000 : 2000, completion_tokens: 20, total_tokens: forceCompaction ? 120020 : 2020 } })}\n\n`
    )
    res.end('data: [DONE]\n\n')
  })
  const gatewayPort = await listenOnLoopback(gateway)
  await mkdir(path.join(root, 'workspace'), { recursive: true })
  if (completionGuardMode) {
    const plugins = path.join(root, 'workspace/.opencode/plugins')
    await mkdir(plugins, { recursive: true })
    await writeFile(
      path.join(plugins, 'untrusted-probe.js'),
      `import {writeFile} from 'node:fs/promises'; export default async()=>{await writeFile(${JSON.stringify(path.join(root, 'untrusted-plugin-ran'))}, 'unexpected');return {}}`
    )
  }
  await mkdir(path.join(root, 'skill'), { recursive: true })
  await writeFile(
    path.join(root, 'skill', 'SKILL.md'),
    '---\nname: zen-smoke\ndescription: Cost-free integration test skill\n---\nUse the local mock transport only.\n'
  )
  const smokeSession = {
    id: 'zen-local-smoke',
    accessible_paths: [path.join(root, 'workspace'), ...(permissions ? [path.join(root, 'authorized 文件')] : [])],
    configuration: { permission_mode: plan ? 'plan' : permissions ? 'default' : 'bypassPermissions' }
  } as any
  if (capacity)
    registerModelCapabilities('local', smokeModel, {
      context_length: 1_000_000,
      max_input_tokens: 900_000,
      max_output_tokens: 128_000,
      tools: true,
      reasoning: true,
      temperature: false,
      input_modalities: ['text', 'image'],
      output_modalities: ['text']
    })
  const config = buildOpenCodeConfig({
    session: lightweight
      ? applyAutomationProfile(smokeSession, { kind: 'wechat', workspace: path.join(root, 'workspace') })
      : smokeSession,
    provider: {
      id: 'local',
      type: 'new-api',
      apiHost: `http://127.0.0.1:${gatewayPort}/v1`,
      apiKey: 'local-placeholder',
      models: [
        {
          id: smokeModel,
          name: 'Local smoke',
          ...(capacity ? { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 } : {})
        }
      ]
    } as any,
    modelId: smokeModel,
    effort: reasoning ? 'high' : undefined,
    inputDirectory: path.join(root, 'input-material'),
    skillPaths: [path.join(root, 'skill')],
    api: { host: '127.0.0.1', port: gatewayPort, apiKey: 'local-placeholder' }
  })
  config.provider['zen-selected'].models[`${smokeModel}-2`] = {
    ...config.provider['zen-selected'].models[smokeModel],
    id: `${smokeModel}-2`,
    name: 'Second mock model'
  }
  const toolBinDir = path.join(root, 'tools')
  const temporaryDirectory = plan
    ? path.join(root, 'tmp')
    : getOpenCodeTempDirectory(smokeSession.accessible_paths[0], smokeSession.id)
  await mkdir(temporaryDirectory, { recursive: true })
  const env = buildOpenCodeEnvironment(
    process.env,
    root,
    'smoke-local-password',
    toolBinDir,
    undefined,
    temporaryDirectory
  )
  const transportEvents: string[] = []
  const transport = await createOpenCodeGateway(config.provider['zen-selected'].options.baseURL, (_id, event) =>
    transportEvents.push(event)
  )
  transport.setOperation('local-smoke-operation')
  config.provider['zen-selected'].options.baseURL = transport.baseURL
  config.provider['zen-selected'].options.headers['x-zen-runtime-token'] = transport.token
  try {
    const completionPlugin = await prepareOpenCodeOfflineConfig(
      root,
      packagedResources
        ? path.join(packagedResources, 'opencode-runtime')
        : path.resolve(__dirname, '../resources/opencode-runtime')
    )
    config.plugin = [pathToFileURL(completionPlugin).href]
  } catch (error) {
    clearTimeout(timeout)
    transport.stop()
    gateway.closeAllConnections()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    throw error
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)
  const nativeStartedAt = performance.now()
  const child = spawn(binary, ['serve', '--hostname=127.0.0.1', '--port=0', '--no-mdns', '--log-level=WARN'], {
    cwd: path.join(root, 'workspace'),
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
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
    for (const key of ['auto', 'prune', 'reserved', 'preserve_recent_tokens'] as const) {
      if (effective.compaction?.[key] !== config.compaction[key]) {
        throw new Error(`Effective native compaction config mismatch: ${key}`)
      }
    }
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
          model: { providerID: 'zen-selected', modelID: smokeModel },
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
    if (loopRecoveryMode) {
      await writeFile(path.join(root, 'workspace', 'evidence.txt'), 'Verified local research evidence DOI:TEST-7319')
      const session = await client.request<{ id: string }>(
        '/session',
        'POST',
        { title: 'Loop recovery smoke' },
        controller.signal
      )
      const recovery = new OpenCodeLoopRecovery()
      const body = {
        agent: 'build',
        model: { providerID: 'zen-selected', modelID: smokeModel },
        parts: [{ type: 'text', text: 'Review existing research evidence and finish the task.' }]
      }
      const events = client.events(controller.signal)
      await events.next()
      let approvals = 0
      let completed = false
      let waitingGeneration = false
      let preservedEvidence = false
      const original = await client.request<any[]>(`/session/${session.id}/message`)
      const previousMessages = new Set(original.map((entry) => entry.info.id))
      await client.request(`/session/${session.id}/prompt_async`, 'POST', body, controller.signal)
      try {
        for await (const event of events) {
          const props = event.properties
          if (props.sessionID && props.sessionID !== session.id) continue
          if (event.type === 'permission.asked' && !recovery.waiting) {
            if (props.permission !== 'doom_loop') throw new Error(`Unexpected permission: ${props.permission}`)
            approvals++
            if (invalidLoopRecoveryMode && !isInvalidReadToolLoop(props.permission, props.metadata))
              throw new Error(`Invalid-read guard did not match native metadata: ${JSON.stringify(props.metadata)}`)
            recovery.reject(
              props.id,
              props.metadata?.tool,
              props.metadata?.input,
              invalidLoopRecoveryMode ? 'invalid-arguments' : 'user-skipped'
            )
            await client.request(
              `/permission/${props.id}/reply`,
              'POST',
              { reply: 'reject', message: 'Skip this repeated invocation and finish the task.' },
              controller.signal
            )
          }
          if (event.type === 'session.error' && !recovery.expects(props.error))
            throw new Error(`Unexpected native failure: ${props.error?.data?.message}`)
          if (event.type !== 'session.status' || props.status?.type !== 'idle') continue
          if (recovery.waiting) {
            const result = await recovery.resume({
              client,
              sessionId: session.id,
              previousMessages,
              body,
              signal: controller.signal,
              onSubmitted: () => {
                waitingGeneration = true
              }
            })
            if (!result) throw new Error('Native rejection did not produce recoverable history')
            if (result.finalizing && approvals !== (invalidLoopRecoveryMode ? 2 : 3))
              throw new Error('Unexpected fallback budget')
            continue
          }
          const history = await client.request<any[]>(`/session/${session.id}/message`)
          const continuation = history.find((entry) => entry.info.id === recovery.latestMessageId)
          preservedEvidence ||= JSON.stringify(continuation?.parts).includes('DOI:TEST-7319')
          const last = history.at(-1)
          if (
            waitingGeneration &&
            last?.info.parentID === recovery.latestMessageId &&
            last.info.time?.completed &&
            !last.info.error
          ) {
            if (
              last.info.agent !== LOOP_SUMMARY_AGENT ||
              !last.parts.some((part: any) => part.text?.includes('Recovered review:'))
            )
              continue
            completed = true
            break
          }
        }
      } finally {
        await events.return(undefined)
      }
      const expectedApprovals = invalidLoopRecoveryMode ? 2 : 3
      if (
        !completed ||
        approvals !== expectedApprovals ||
        summaryTools !== 0 ||
        !preservedEvidence ||
        Number(requests) !== expectedApprovals + 1
      )
        throw new Error(
          `Recovery verification failed: completed=${completed} approvals=${approvals} tools=${summaryTools} evidence=${preservedEvidence} requests=${requests}`
        )
      const next = await client.request<any>(`/session/${session.id}/message`, 'POST', {
        agent: 'build',
        model: body.model,
        noReply: true,
        parts: [{ type: 'text', text: 'A normal following turn keeps Build permissions.' }]
      })
      if (next.info.agent !== 'build') throw new Error('Fallback leaked into following turns')
      process.stdout.write(
        invalidLoopRecoveryMode
          ? 'PASS native invalid-argument recovery: correct metadata classification, one repair, tool-free finalization, retained evidence and following Build permissions; 3 local mock requests, zero paid requests.\n'
          : 'PASS native repeated-operation recovery: three explicit rejections, same history, successful evidence retained, bounded tool-free final answer, following Build turn unchanged; 4 local mock requests, zero paid requests.\n'
      )
      return
    }
    if (permissions || plan) {
      const agents = await client.request<any[]>('/agent', 'GET', undefined, controller.signal)
      const rule = (agent: string, permission: string, pattern: string) =>
        agents
          .find((entry) => entry.name === agent)
          ?.permission.findLast((entry: any) => entry.permission === permission && entry.pattern === pattern)?.action
      if (plan) {
        for (const permission of ['edit', 'bash', 'mcp__assistant_*', 'mcp__browser_*']) {
          if (rule('plan', permission, '*') !== 'deny') throw new Error(`Native Plan did not deny ${permission}`)
        }
        if (rule('plan', 'mcp__assistant__read_document', '*') !== 'allow')
          throw new Error('Native Plan lost authorized document reading')
        process.stdout.write(
          'PASS native Plan: no editing, terminal or mutating MCP; authorized document reading retained; zero paid requests.\n'
        )
        return
      }
      if (
        rule('build', '*', '*') !== 'allow' ||
        rule('build', 'read', '*.env') !== 'ask' ||
        rule('build', 'doom_loop', '*') !== 'ask' ||
        rule('build', 'bash', 'rm *') !== 'ask' ||
        rule('plan', 'edit', '*') !== 'deny'
      )
        throw new Error('Native Plan/Build rules lost their execution or safety boundary')
      // Exercise real native permissions, including Windows paths and a second
      // access after a one-time approval. Never substitute a blanket allow rule.
      await mkdir(path.join(root, 'authorized 文件'), { recursive: true })
      await mkdir(path.join(root, 'outside'), { recursive: true })
      const cases = [
        { file: path.join(root, 'workspace', 'result.txt') },
        { file: path.join(root, 'workspace', 'approval.txt'), permission: 'edit' },
        { file: path.join(temporaryDirectory, 'sources.json') },
        { file: path.join(root, 'authorized 文件', 'report.md') },
        { file: path.join(root, 'outside', 'first.txt'), permission: 'external_directory' },
        { file: path.join(root, 'outside', 'second.txt'), permission: 'external_directory' },
        { file: path.join(root, 'outside', 'denied.txt'), permission: 'external_directory', reject: true }
      ]
      let externalSession: { id: string } | undefined
      for (const sample of cases) {
        const ask = Boolean(sample.permission)
        writeTarget = sample.file
        const session =
          (sample.permission === 'external_directory' && externalSession) ||
          (await client.request<{ id: string }>(
            '/session',
            'POST',
            {
              title: ask ? 'Native explicit approval' : 'Native Build automatic write',
              ...(sample.permission === 'edit'
                ? { permission: [{ permission: 'edit', pattern: '*', action: 'ask' }] }
                : {})
            },
            controller.signal
          ))
        if (sample.permission === 'external_directory') externalSession = session
        const events = client.events(controller.signal)
        await events.next()
        const submit = client.request(
          `/session/${session.id}/prompt_async`,
          'POST',
          {
            agent: 'build',
            model: { providerID: 'zen-selected', modelID: smokeModel },
            parts: [{ type: 'text', text: ask ? 'CREATE_SMOKE_FILE_APPROVAL' : 'CREATE_SMOKE_FILE' }]
          },
          controller.signal
        )
        let approvals = 0
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
              !ask ||
              props.permission !== sample.permission ||
              path.resolve(props.metadata.filepath) !== sample.file ||
              !props.tool?.callID
            )
              throw new Error(`Unexpected native approval request for ${sample.file}: ${JSON.stringify(props)}`)
            await client.request(
              `/permission/${props.id}/reply`,
              'POST',
              { reply: sample.reject ? 'reject' : 'once' },
              controller.signal
            )
            approvals++
          }
          if (
            event.type === 'message.part.updated' &&
            props.part.type === 'text' &&
            props.part.text?.includes('local mock reply')
          )
            output = true
          if (
            (!ask || approvals) &&
            (output || sample.reject) &&
            event.type === 'session.status' &&
            props.status.type === 'idle'
          )
            break
        }
        await submit
        if (approvals !== Number(ask) || (!output && !sample.reject))
          throw new Error(`Native ${sample.file} did not complete with the expected approval count`)
        if (sample.reject) {
          const contents = await readFile(sample.file, 'utf8').catch((error) => {
            if (error.code !== 'ENOENT') throw error
            return undefined
          })
          if (contents !== undefined) throw new Error('Rejected external write created a file')
        } else if ((await readFile(sample.file, 'utf8')) !== 'verified local tool execution') {
          throw new Error(`Native ${sample.file} was not written`)
        }
        await events.return(undefined)
        process.stdout.write(
          `PASS native workspace permission: ${sample.file}; approvals=${approvals}; rejected=${Boolean(sample.reject)}\n`
        )
      }
      process.stdout.write(
        'PASS native Build: workspace/temp/authorized-folder writes, outside approval and rejection, no implicit persistent grants; zero paid requests.\n'
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
      { agent: 'build', model: { providerID: 'zen-selected', modelID: smokeModel }, command: 'zen-smoke-tool' },
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
        model: { providerID: 'zen-selected', modelID: smokeModel },
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
    const turn = async (text: string, modelID = smokeModel, targetSession = session.id) => {
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
        {
          agent: contextStage === 'material' ? 'plan' : undefined,
          model: { providerID: 'zen-selected', modelID },
          parts: [{ type: 'text', text }]
        },
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
          if (event.type === 'session.error') {
            if (contextRecoveryMode && event.properties.error?.name === 'ContextOverflowError') nativeContextErrors++
            else throw new Error(`Native turn error: ${JSON.stringify(event.properties.error)}`)
          }
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
        if (!output && contextStage !== 'failure') throw new Error('Missing native model output')
        const audits = requestAudits.slice(auditStart)
        if (!audits.length || audits.some((audit) => audit.source !== 'zenai_opencode' || audit.task !== taskId))
          throw new Error('Native model requests lost their Open Code source or per-turn task marker')
      } finally {
        eventsController.abort()
      }
      return Math.round(performance.now() - turnStartedAt)
    }
    if (contextRecoveryMode) {
      contextStage = 'recovery'
      await turn('NATIVE_OVERFLOW_RECOVERY: complete this request after context compaction')
      const recovered = await client.request<any[]>(
        `/session/${session.id}/message`,
        'GET',
        undefined,
        controller.signal
      )
      if (
        contextErrors !== 1 ||
        nativeContextErrors !== 1 ||
        !recovered.some((entry) => entry.info.summary && !entry.info.error) ||
        recovered.at(-1)?.info.error
      )
        throw new Error('Native context overflow did not recover through a durable checkpoint')
      contextStage = 'failure'
      const failedSession = await client.request<{ id: string }>('/session', 'POST', {}, controller.signal)
      await turn('NATIVE_OVERFLOW_FAILURE', smokeModel, failedSession.id)
      const failed = await client.request<any[]>(
        `/session/${failedSession.id}/message`,
        'GET',
        undefined,
        controller.signal
      )
      if (!failed.some((entry) => entry.info.summary && entry.info.error?.name === 'ContextOverflowError'))
        throw new Error('Native compaction overflow did not terminate with a durable error')
      contextStage = 'material'
      const source = 'USER-REQUEST-START\n' + 'RAW_LARGE_MATERIAL_'.repeat(30_000) + '\nEND-LARGE-SUBMISSION'
      const prepared = await prepareOpenCodeInput({
        text: source,
        directory: path.join(root, 'input-material'),
        system: '',
        usableInput: 104_000,
        signal: controller.signal
      })
      if (!prepared.material) throw new Error('Large first input was not materialized')
      const manifest = JSON.parse(await readFile(path.join(prepared.material.directory, 'manifest.json'), 'utf8'))
      materialRead = {
        filePath: path.join(prepared.material.directory, 'segments.jsonl'),
        count: manifest.segmentCount,
        limit: manifest.readLines
      }
      const materialSession = await client.request<{ id: string }>('/session', 'POST', {}, controller.signal)
      await turn(prepared.text, smokeModel, materialSession.id)
      if (
        !materialVerified ||
        (await readFile(path.join(prepared.material.directory, 'original.txt'), 'utf8')) !== source
      )
        throw new Error('Native Plan could not retrieve the lossless large first submission')
      process.stdout.write(
        `PASS native context recovery: recoverable overflow compacts and resumes; failed compaction ends; large first input read in Plan from durable material (${requests} local mock requests, zero paid requests).\n`
      )
      return
    }
    if (completionGuardMode) {
      await turn('COMPACT_NOW final report')
      const done = await client.request<any[]>(`/session/${session.id}/message`, 'GET', undefined, controller.signal)
      if (
        Number(requests) !== 2 ||
        !done.some((entry) => entry.info.summary) ||
        done.some(
          (entry) =>
            entry.info.role === 'user' &&
            entry.parts.some((part: any) => part.synthetic && part.text?.startsWith('Continue if'))
        )
      )
        throw new Error(`Completed answer revived after compaction (${requests} model requests)`)
      const ongoing = await client.request<{ id: string }>('/session', 'POST', {}, controller.signal)
      const before = requests
      await turn('CREATE_SMOKE_FILE COMPACT_NOW', smokeModel, ongoing.id)
      const working = await client.request<any[]>(`/session/${ongoing.id}/message`, 'GET', undefined, controller.signal)
      if (
        requests - before < 3 ||
        !working.some((entry) => entry.info.summary) ||
        !working.some((entry) =>
          entry.parts.some((part: any) => part.synthetic && part.text?.startsWith('Continue if'))
        )
      )
        throw new Error('Mid-task tool compaction lost native continuation')
      if (!(await readFile(path.join(root, 'workspace/result.txt'), 'utf8')).includes('verified local tool execution'))
        throw new Error('Mid-task tool execution was lost')
      if (await readFile(path.join(root, 'untrusted-plugin-ran'), 'utf8').catch(() => undefined))
        throw new Error('Untrusted workspace plugin executed')
      const paperSession = await client.request<{ id: string }>('/session', 'POST', {}, controller.signal)
      await turn('WEBFETCH_PDF', smokeModel, paperSession.id)
      if (!sawPdfParserGuard) throw new Error('Native webfetch did not route PDF bytes to the parser')
      console.log(
        `PASS native completion guard: final answer compacts without revival; mid-tool compaction still continues; raw PDF excluded; workspace plugin isolated (${requests} local mock requests, zero paid requests).`
      )
      return
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
    if (
      (await readFile(path.join(root, 'workspace', 'result.txt'), 'utf8')) !==
      `verified local tool execution${reasoning ? '\n' : ''}`
    )
      throw new Error('Native tool file verification failed')
    const history = await client.request<any[]>(`/session/${session.id}/message`, 'GET', undefined, controller.signal)
    if (history.filter((item) => item.info.role === 'user').length !== 3)
      throw new Error('Native history continuity failed')
    await client.request(
      `/session/${session.id}/summarize`,
      'POST',
      { providerID: 'zen-selected', modelID: smokeModel },
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
    await turn('hello after compaction', `${smokeModel}-2`)
    if (reasoning && !reasoningVerified) throw new Error('Native model request lost the configured reasoning effort')
    if (!usedModels.has(`${smokeModel}-2`)) throw new Error('Native model switch did not use the requested model')
    const cancelEvents = new AbortController()
    const cancelIterator = client.events(AbortSignal.any([cancelEvents.signal, controller.signal]))
    await cancelIterator.next()
    const cancellable = client.request(
      `/session/${session.id}/prompt_async`,
      'POST',
      {
        model: { providerID: 'zen-selected', modelID: smokeModel },
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
    await turn('hello in branch after deletion', smokeModel, branch.id)
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
    if (capacity && !capacityOutputVerified)
      throw new Error('Native output budget changed; revisit compaction reserves')
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
