// Private Zen transport over the pinned, unmodified official DSH Agent runtime.
// Stdout is JSONL only. No HTTP listener or renderer credentials are involved.
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const runtimeRoot = path.resolve(process.argv[2])
const home = path.resolve(process.env.DSH_HOME)
const runtimeRequire = createRequire(path.join(runtimeRoot, 'package.json'))
const load = (name) => import(pathToFileURL(runtimeRequire.resolve(name)).href)
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
const pendingAnswers = new Map()
let root
let handle
let closing = false
let nextRequest = 1
let initializePromise

function send(frame) {
  if (!process.stdout.destroyed) process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function notice(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function ask(method, params, signal) {
  if (signal?.aborted || closing) return Promise.resolve({ outcome: 'cancelled' })
  const id = `host-${nextRequest++}`
  return new Promise((resolve) => {
    const finish = (value) => {
      pendingAnswers.delete(id)
      signal?.removeEventListener('abort', abort)
      resolve(value)
    }
    const abort = () => {
      notice('host.cancelled', { id })
      finish({ outcome: 'cancelled' })
    }
    pendingAnswers.set(id, finish)
    signal?.addEventListener('abort', abort, { once: true })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

async function initialize(params) {
  if (root) throw new Error('Runtime is already initialized')
  if (!params || !path.isAbsolute(params.cwd) || !/^zen-[a-zA-Z0-9_-]+$/.test(params.sessionId))
    throw new Error('Invalid Zen DSH session identity or working directory')
  process.chdir(params.cwd)
  process.env.ZEN_DSH_PROVIDER_KEY = params.provider.apiKey || 'not-required'
  const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment')
  const { runProfile } = await load('@deepseek-ai/dsh/profile-boot')
  const { createUserMessage, freezeMessage } = await load('@deepseek-ai/dsh-llm')
  const { installModelSelection } = await load('@deepseek-ai/dsh-agent')
  const { admitEncodedImages } = await load('@deepseek-ai/dsh-attachment')
  const profile = path.join(home, 'profiles', 'zen')
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'zen-dsh-private-profile', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
  const disabled = ['plugin-manager', 'tool-plugin-manager', 'hmr', 'config-editor', 'settings', 'session-title-llm', 'authorization', 'deepseek-account', 'credentials', 'llm-deepseek', 'llm-deepseek-account', 'session-telemetry-otel', 'tool-web', 'web-search-deepseek', 'web-deepseek-api']
  const route = {
    api: params.provider.api,
    baseURL: params.provider.baseURL,
    apiKeyEnv: 'ZEN_DSH_PROVIDER_KEY',
    headers: params.provider.headers || {},
    models: [{ id: params.provider.model, name: params.provider.model, input: ['text', 'image'], contextWindow: params.provider.contextWindow || 128000, maxTokens: params.provider.maxTokens || 16000 }],
    retryPolicy: { mode: 'normal', maxRetries: 0 },
    timeoutMs: 300000,
    streamIdleTimeoutMs: 300000,
    ...(params.provider.compat ? { compat: params.provider.compat } : {})
  }
  // Provider secrets and MCP bearer headers live only in the pipe/process.
  // Config expressions read private bootstrap values without serializing them.
  const patch = [
    ...disabled.map((id) => ({ id, disabled: true })),
    { id: 'llm-pi-ai', config: { providers: { 'zen-selected': null } } },
    { id: 'agent-default-model', config: { provider: 'zen-selected', model: params.provider.model } },
    { id: 'sandbox-policy', config: { mode: params.readOnly ? 'read-only' : 'workspace-write', workspaceRoot: params.cwd, additionalWritableRoots: params.additionalRoots || [] } },
    { id: 'approval', config: { policy: 'ask' } },
    { id: 'skill-filesystem', config: { includeDefaultRoots: false, customSkillDirs: params.skillRoots || [], watch: false } },
    { id: 'system-prompt', config: { personaPrefix: params.instructions || 'You are Zen AI, a practical assistant. Use the available tools to complete the user task and deliver real files.' } }
  ]
  // The following row is replaced in memory after boot, so no headers/keys are
  // ever written to profile files. No model is called until session/prompt.
  patch.find((entry) => entry.id === 'llm-pi-ai').disabled = true
  await writeFile(path.join(profile, 'cordis.patch.yml'), JSON.stringify(patch))
  root = await runProfile({ profile: 'zen', patchFiles: [], args: [], environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { ...process.env } }]) })
  const ctx = root.ctx
  const PiAi = await load('@deepseek-ai/dsh-llm-pi-ai')
  await ctx.plugin(PiAi, { providers: { 'zen-selected': route } })
  const Mcp = params.mcp?.length ? await load('@deepseek-ai/dsh-mcp-client') : undefined
  for (const server of params.mcp || []) await ctx.plugin(Mcp, server)
  await ctx.get('loader')?.await()
  const sessionId = params.sessionId
  const options = { provider: 'zen-selected', model: params.provider.model, ...(params.effort ? { reasoningEffort: params.effort } : {}) }
  const setup = (agentCtx, agent) => {
    installModelSelection(agentCtx)
    agent.model.select(options)
  }
  const toolInputs = new Map()
  ctx.on('session/event', (session, event) => notice('session.event', { sessionId: session.id, event }))
  ctx.on('agent/assistant-stream', ({ agent, frame }) => notice('assistant.stream', { sessionId: agent.id, frame }))
  ctx.on('agent/status', ({ agent, status }) => notice('session.status', { sessionId: agent.id, status }))
  ctx.on('agent/error', ({ agent, error }) => notice('session.error', { sessionId: agent.id, error: { message: error instanceof Error ? error.message : String(error) } }))
  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent) return
    notice('tool.output', { sessionId: exec.agent.id, callId: exec.callId, name: exec.name, ...(result.isError ? { error: result.error } : { value: result.value }) })
    toolInputs.delete(`${exec.agent.id}:${exec.callId}`)
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent) toolInputs.set(`${exec.agent.id}:${exec.callId}`, exec.arguments)
    const external = (params.approveToolPrefixes || []).some((prefix) => exec.name.startsWith(prefix))
    if (params.readOnly && (external || exec.name.startsWith('mcp__browser__')))
      return { kind: 'deny', reason: 'Plan mode does not permit external MCP or browser actions. Switch to Build to execute.' }
    const decision = await next()
    if (decision.kind !== 'allow' || !external) return decision
    return { kind: 'ask', reason: 'External MCP tools require confirmation in the DeepSeek Harness preview.' }
  })
  ctx.on('approval/request', async (request) => {
    const result = await ask('approval/request', { sessionId: request.agent.id, toolName: request.toolName, callId: request.callId, reason: request.reason, toolInput: toolInputs.get(`${request.agent.id}:${request.callId}`) }, request.signal)
    return ['allowed-once', 'rejected', 'cancelled'].includes(result?.outcome) ? result.outcome : 'rejected'
  })
  if (params.resume) {
    handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: options, setup })
  } else {
    handle = await ctx.agents.create({ sessionId, meta: { cwd: params.cwd }, agentOptions: options, setup, ...(params.seed ? { seed: params.seed } : {}) })
  }
  const agent = handle.agent
  if (agent.session.header.cwd !== params.cwd) throw new Error('Persisted DSH session belongs to another workspace')
  const contentOf = async (request) => {
    const content = [{ type: 'text', text: request.text }]
    if (request.images?.length) {
      const images = await admitEncodedImages(ctx.attachments, request.images.map((image) => ({ data: image.data, mediaType: image.media_type })))
      content.push(...images.map((attachment) => ({ type: 'image', attachment })))
    }
    return content
  }
  return {
    sessionId,
    seq: agent.session.seq,
    // Retained in this process, never serialized as RPC response.
    handlers: {
      async 'session/prompt'(request) {
        const message = createUserMessage({ content: await contentOf(request), source: { kind: 'user' } })
        agent.followup(message)
        return { messageId: message.id }
      },
      async 'session/steer'(request) {
        if (!/^zen-input-[0-9a-f]{32}$/.test(request.messageId || '')) throw new Error('Invalid steering message identity')
        const exists = agent.inbox.nextStep.some((message) => message.id === request.messageId) || agent.inbox.nextTurn.some((message) => message.id === request.messageId) || Array.from({ length: agent.session.seq }, (_, seq) => agent.session.eventAt(seq)).some((event) => event?.type === 'user/message' && event.data.id === request.messageId)
        if (exists) return { messageId: request.messageId }
        const message = freezeMessage({ ...createUserMessage({ content: await contentOf(request), source: { kind: 'user' } }), id: request.messageId })
        agent.steer(message)
        return { messageId: message.id }
      },
      async 'session/wait'() {
        while (true) {
          await agent.whenIdle()
          const seq = agent.session.seq
          const children = await ctx.get('subagents')?.waitForChildren(agent)
          if (!children && agent.status === 'idle' && seq === agent.session.seq) break
        }
        await ctx.sessions.flush(agent.session)
        return { seq: agent.session.seq }
      },
      async 'session/cancel'() {
        agent.cancel({ kind: 'user' })
        // Root cancellation alone does not own a background child's signal.
        // Close and await this exact root's descendant forest as well.
        await ctx.get('subagents')?.drainDescendants([agent])
        return {}
      },
      'session/history'() {
        return { sessionId: agent.id, header: agent.session.header, events: Array.from({ length: agent.session.seq }, (_, seq) => agent.session.eventAt(seq)) }
      },
      async 'session/skills'() {
        const skills = await ctx.skills.list({ cwd: params.cwd, scope: agent })
        return skills.map((skill) => ({ name: skill.name, description: skill.description, location: skill.path }))
      },
      async shutdown() { await shutdown(); return {} }
    }
  }
}

let handlers = {}
async function dispatch(frame) {
  if (Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error')) {
    pendingAnswers.get(frame.id)?.(frame.result || { outcome: 'rejected' })
    return
  }
  const { id, method, params } = frame
  try {
    let result
    if (method === 'initialize') {
      if (initializePromise) throw new Error('Runtime initialization already requested')
      initializePromise = initialize(params)
      const initialized = await initializePromise
      handlers = initialized.handlers
      result = { sessionId: initialized.sessionId, seq: initialized.seq }
    } else {
      await initializePromise
      if (typeof handlers[method] !== 'function') throw new Error('Unknown Zen DSH bridge method')
      result = await handlers[method](params || {})
    }
    send({ jsonrpc: '2.0', id, result })
    if (method === 'shutdown') process.exit(0)
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : 'DSH bridge failed' } })
    if (method === 'initialize') { await shutdown(); process.exit(1) }
  }
}

async function shutdown() {
  if (closing) return
  closing = true
  for (const finish of pendingAnswers.values()) finish({ outcome: 'cancelled' })
  if (handle) { await handle.dispose(); handle = undefined }
  if (root) await root.shutdown.shutdown(0)
}

if (process.argv[3] === '--verify') {
  // Boot the real pinned native stack without admitting a prompt or making a
  // model/network request. Preparation must detect native ABI incompatibility.
  await initialize({ sessionId: `zen-verify-${randomUUID()}`, cwd: home, provider: { api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1', model: 'zen-verification', apiKey: 'not-used' }, skillRoots: [] })
  await shutdown()
  process.exit(0)
}

input.on('line', (line) => {
  if (Buffer.byteLength(line) > 48 * 1024 * 1024) { void shutdown().finally(() => process.exit(1)); return }
  try { void dispatch(JSON.parse(line)) } catch { void shutdown().finally(() => process.exit(1)) }
})
input.on('close', () => { void shutdown().finally(() => process.exit(0)) })
process.on('SIGTERM', () => { void shutdown().finally(() => process.exit(0)) })
process.on('SIGINT', () => { void shutdown().finally(() => process.exit(0)) })
notice('bridge.ready', { version: '0.2.2-alpha.3', instanceId: randomUUID() })
