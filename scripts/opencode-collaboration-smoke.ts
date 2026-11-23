// Cost-free native integration: synthetic provider, isolated files and loopback only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { listenOnLoopback } from '../packages/shared/utils/loopbackServer'
import { OpenCodeClient } from '../src/main/services/agents/services/opencode/client'
import {
  assistantMcpAlias,
  buildOpenCodeConfig,
  buildOpenCodeEnvironment,
  OPENCODE_VERSION
} from '../src/main/services/agents/services/opencode/config'
import {
  AssistantFileChangeStore,
  AssistantFileChangeTurn
} from '../src/main/services/agents/services/opencode/fileChanges'
import { getOpenCodeSharedInstructions } from '../src/main/services/agents/services/opencode/instructions'
import { prepareOpenCodeOfflineConfig } from '../src/main/services/agents/services/opencode/offline'
import { answerOpenCodeQuestion, type OpenCodeQuestion } from '../src/main/services/agents/services/opencode/questions'
import { OpenCodeSubagents } from '../src/main/services/agents/services/opencode/subagents'

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'Zen-native-collaboration-'))
  const workspace = path.join(root, 'workspace')
  await mkdir(workspace)
  await mkdir(path.join(root, 'tmp'))
  const file = path.join(workspace, 'fixture.txt')
  await writeFile(file, 'Synthetic local audit fixture.\n')
  const fileStore = new AssistantFileChangeStore(path.join(root, 'journal'), 'phase-two')
  const fileTurn = new AssistantFileChangeTurn(fileStore, 'smoke-turn', [workspace], new AbortController().signal)
  const testMcpId = 'synthetic-mcp'
  const alias = assistantMcpAlias(testMcpId)
  const toolName = `${alias}_lookup`
  let approvedExternalCalls = 0
  let externalCalls = 0
  const marker = 'ZEN_SHARED_CHILD_REQUIREMENT'
  const calls: Array<{ child: boolean; shared: boolean; tools: string[] }> = []
  let parentIdleBeforeChild = false
  let backgroundResultWithRules = false
  let foreignChild = ''
  const held = Promise.withResolvers<ServerResponse>()
  const background = Promise.withResolvers<ServerResponse>()
  const backgroundStop = Promise.withResolvers<ServerResponse>()
  const waitForModelRequest = (request: Promise<ServerResponse>) =>
    Promise.race([
      request,
      delay(5000, undefined, { ref: false }).then(() => {
        throw new Error('Child model request did not start')
      })
    ])
  const provider = createServer(async (req, res) => {
    if (req.url === '/v1/assistant/synthetic/file-changes' && req.method === 'POST') {
      const data: Buffer[] = []
      for await (const chunk of req) data.push(Buffer.from(chunk))
      const { action, callId, files } = JSON.parse(Buffer.concat(data).toString())
      if (action === 'begin') await fileTurn.begin(callId, files)
      else if (action === 'finish') await fileTurn.finish(callId)
      res.writeHead(204).end()
      return
    }
    if (req.url === `/v1/assistant/synthetic/integrations/${testMcpId}/mcp`) {
      const mcp = new Server({ name: 'smoke-mcp', version: '0' }, { capabilities: { tools: {} } })
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'lookup', description: 'Synthetic read-only lookup', inputSchema: { type: 'object' } }]
      }))
      mcp.setRequestHandler(CallToolRequestSchema, async () => {
        externalCalls++
        return { content: [{ type: 'text', text: 'Synthetic lookup passed' }] }
      })
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
      try {
        await mcp.connect(transport)
        await transport.handleRequest(req, res)
      } finally {
        await mcp.close()
      }
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const userIndex = body.messages.findLastIndex((item: any) => item.role === 'user')
    const user = JSON.stringify(body.messages[userIndex])
    const child = user.includes('CHILD_')
    const result = body.messages.slice(userIndex + 1).some((item: any) => item.role === 'tool')
    calls.push({
      child,
      shared: JSON.stringify(body.messages).includes(marker),
      tools: (body.tools ?? []).map((tool: any) => tool.function?.name)
    })
    const waiting = user.includes('CHILD_CANCEL')
      ? held
      : user.includes('CHILD_BACKGROUND_STOP')
        ? backgroundStop
        : user.includes('CHILD_BACKGROUND')
          ? background
          : undefined
    if (waiting) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.flushHeaders()
      waiting.resolve(res)
      return
    }
    const call = (name: string, args: unknown, index = 0) => ({
      index,
      id: `call-${calls.length}-${index}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) }
    })
    const clarification = () =>
      call('question', {
        questions: [
          {
            header: 'Formats',
            question: 'Choose formats',
            multiple: true,
            options: [
              { label: 'A,B', description: 'Comma stays within one choice' },
              { label: 'C', description: 'Second choice' }
            ]
          }
        ]
      })
    const backgroundResult =
      user.includes('Background task completed:') && user.includes('Synthetic background finding')
    if (backgroundResult) backgroundResultWithRules = JSON.stringify(body.messages.slice(0, userIndex)).includes(marker)
    const delta = backgroundResult
      ? { content: 'Synthetic result returned. Integrated background finding.' }
      : result
        ? { content: 'Synthetic result returned.' }
        : user.includes('BACKGROUND_PARENT') || user.includes('BACKGROUND_STOP_PARENT')
          ? {
              tool_calls: [
                call('task', {
                  description: 'Synthetic background lookup',
                  subagent_type: 'general',
                  background: true,
                  prompt: user.includes('BACKGROUND_STOP_PARENT')
                    ? 'CHILD_BACKGROUND_STOP: wait for the runtime to stop.'
                    : 'CHILD_BACKGROUND: return a finding.'
                })
              ]
            }
          : child
            ? {
                tool_calls: [user.includes('CHILD_1') ? clarification() : call('read', { filePath: file })]
              }
            : user.includes('FILE_MCP_PARENT')
              ? {
                  tool_calls: [
                    call('write', { filePath: file, content: 'Checked replacement\n' }),
                    call(toolName, {}, 1)
                  ]
                }
              : user.includes('ROOT_QUESTION_')
                ? { tool_calls: [clarification()] }
                : {
                    tool_calls: (user.includes('CANCEL_PARENT') ||
                    user.includes('CROSS_PARENT') ||
                    user.includes('OWN_PARENT')
                      ? [0]
                      : [0, 1, 2]
                    ).map((index) =>
                      call(
                        'task',
                        {
                          description: `Synthetic task ${index + 1}`,
                          subagent_type: index === 2 ? 'explore' : 'general',
                          ...(user.includes('CROSS_PARENT') || user.includes('OWN_PARENT')
                            ? { task_id: foreignChild }
                            : {}),
                          prompt: user.includes('CANCEL_PARENT')
                            ? 'CHILD_CANCEL: wait for test cancellation.'
                            : `CHILD_${index + 1}: complete the synthetic task.`
                        },
                        index
                      )
                    )
                  }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const common = { id: `native-test-${calls.length}`, object: 'chat.completion.chunk', created: 1, model: 'zen-test' }
    res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    res.write(
      `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'content' in delta ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: child ? 200 : 100, completion_tokens: 10, total_tokens: child ? 210 : 110 } })}\n\n`
    )
    res.end('data: [DONE]\n\n')
  })
  const port = await listenOnLoopback(provider)
  const session = { id: 'synthetic', accessible_paths: [workspace], instructions: marker, configuration: {} } as any
  const config = buildOpenCodeConfig({
    session,
    provider: {
      id: 'local',
      type: 'openai',
      apiHost: `http://127.0.0.1:${port}`,
      apiKey: 'synthetic-placeholder',
      models: [{ id: 'zen-test' }]
    } as any,
    modelId: 'zen-test',
    skillPaths: [],
    api: { host: '127.0.0.1', port, apiKey: 'synthetic-placeholder' },
    integrationIds: [testMcpId]
  })
  config.mcp = { [alias]: config.mcp[alias] }
  Object.assign(config.permission, { read: { '*': 'ask' } })
  config.plugin = [
    pathToFileURL(await prepareOpenCodeOfflineConfig(root, path.resolve('resources/opencode-runtime'))).href
  ]
  const password = randomBytes(20).toString('hex')
  const env = buildOpenCodeEnvironment(process.env, root, password)
  env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = 'true'
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)
  env.ZEN_FILE_CHANGES_URL = `http://127.0.0.1:${port}/v1/assistant/synthetic/file-changes`
  env.ZEN_FILE_CHANGES_AUTH = 'Bearer synthetic-placeholder'
  env.ZEN_FILE_CHANGES_TOKEN = 'synthetic-local-secret'
  const require = createRequire(__filename)
  const wrapper = createRequire(require.resolve('opencode-ai/package.json'))
  const target = `opencode-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}${process.arch === 'x64' ? '-baseline' : ''}`
  const binary = path.join(
    path.dirname(wrapper.resolve(`${target}/package.json`)),
    'bin',
    process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  )
  const child = spawn(binary, ['serve', '--hostname=127.0.0.1', '--port=0', '--no-mdns', '--log-level=WARN'], {
    cwd: workspace,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Native collaboration test timed out')), 90_000)
  child.stderr.on('data', () => {})
  try {
    const address = await new Promise<string>((resolve, reject) => {
      let output = ''
      child.stdout.on('data', (data) => {
        output += String(data)
        const match = output.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/)
        if (match) resolve(match[1])
      })
      child.once('exit', () => reject(new Error('Native runtime exited')))
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    })
    const client = new OpenCodeClient(address, password, workspace)
    assert.equal((await client.request<{ version: string }>('/global/health')).version, OPENCODE_VERSION)
    let approvedChildPermissions = 0
    let questionAnswers = 0
    let queued = false
    let maximumActive = 0
    async function turn(text: string, stop: 'session' | 'runtime' | false = false, existingParent?: string) {
      const native = existingParent
        ? { id: existingParent }
        : await client.request<{ id: string }>(
            '/session',
            'POST',
            { title: 'Synthetic collaboration' },
            controller.signal
          )
      const tree = new OpenCodeSubagents(client, native.id, 'synthetic', controller.signal, (items) => {
        queued ||= items.some((item) => item.status === 'queued')
        maximumActive = Math.max(
          maximumActive,
          items.filter((item) => ['running', 'waiting_permission', 'waiting_answer'].includes(item.status)).length
        )
      })
      const streamController = new AbortController()
      const events = client.events(AbortSignal.any([controller.signal, streamController.signal]))
      await events.next()
      const pending = new Set<Promise<void>>()
      let busy = false
      const handling = (async () => {
        for await (const event of events) {
          const props = event.properties
          const id = props.sessionID || props.info?.sessionID || props.part?.sessionID
          if (id && !(await tree.owns(id))) continue
          if (event.type === 'message.part.updated' && id === native.id) await tree.observeParent(props.part)
          if (event.type === 'permission.asked') {
            const task = (async () => {
              if (props.permission === 'task') {
                const accepted = await tree.admit(
                  `synthetic:${props.tool.callID}`,
                  props.metadata.description,
                  props.metadata.subagent_type
                )
                await client.request(
                  `/permission/${props.id}/reply`,
                  'POST',
                  { reply: accepted ? 'once' : 'reject' },
                  controller.signal
                )
              } else if (props.permission === toolName) {
                assert.equal(id, native.id)
                assert.equal(externalCalls, 0, 'External tools must wait for approval')
                approvedExternalCalls++
                await client.request(`/permission/${props.id}/reply`, 'POST', { reply: 'once' }, controller.signal)
              } else {
                assert.notEqual(id, native.id)
                approvedChildPermissions++
                await client.request(`/permission/${props.id}/reply`, 'POST', { reply: 'once' }, controller.signal)
              }
            })()
            pending.add(task)
            void task.finally(() => pending.delete(task))
          }
          if (event.type === 'question.asked') {
            const task = answerOpenCodeQuestion({
              question: props as OpenCodeQuestion,
              client,
              toolCallId: `${tree.toolCallPrefix(id)}:${props.tool.callID}`,
              signal: controller.signal,
              ask: async (_name, input) => {
                questionAnswers++
                assert.equal((input.questions as any[])[0].multiSelect, true)
                return text.includes('DISMISS_PARENT')
                  ? { behavior: 'deny', message: 'Synthetic user dismissed the question' }
                  : { behavior: 'allow', updatedInput: { nativeAnswers: [['A,B', 'C']] } }
              }
            })
            pending.add(task)
            void task.finally(() => pending.delete(task))
          }
          if (id && id !== native.id) tree.child(event, id)
          if (event.type === 'session.status' && id === native.id) {
            if (props.status.type === 'busy') busy = true
            if (busy && props.status.type === 'idle') {
              if (text.startsWith('BACKGROUND_PARENT') && tree.unfinished) {
                parentIdleBeforeChild = true
                const response = await waitForModelRequest(background.promise)
                if (response.writableEnded) continue
                const common = { id: 'background-test', object: 'chat.completion.chunk', created: 1, model: 'zen-test' }
                response.write(
                  `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { content: 'Synthetic background finding' }, finish_reason: null }] })}\n\n`
                )
                response.end(
                  `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
                )
                continue
              }
              if (stop === 'runtime') assert(tree.unfinished, 'Background child must still be active at parent idle')
              break
            }
          }
        }
      })()
      await client.request(
        `/session/${native.id}/prompt_async`,
        'POST',
        {
          agent: 'build',
          model: { providerID: 'zen-selected', modelID: 'zen-test' },
          system: getOpenCodeSharedInstructions(session),
          parts: [{ type: 'text', text }]
        },
        controller.signal
      )
      if (stop === 'session') {
        const response = await waitForModelRequest(held.promise)
        await Promise.all([
          once(response, 'close', { signal: AbortSignal.timeout(5000) }),
          client.request(`/session/${native.id}/abort`, 'POST', {}, controller.signal)
        ])
      }
      await handling
      await Promise.all(pending)
      if (!stop) {
        assert.equal(tree.unfinished, false)
        const history = await client.request<Array<{ info: any; parts: any[] }>>(`/session/${native.id}/message`)
        assert(
          history
            .at(-1)
            ?.parts.some((part) => part.type === 'text' && part.text.includes('Synthetic result returned.')),
          'The native parent must deliver a final answer, including after a dismissed question'
        )
      }
      tree.close('cancelled')
      streamController.abort('Test turn finished')
      return native.id
    }
    const firstParent = await turn('PARENT: delegate three independent synthetic tasks.')
    assert.equal(approvedChildPermissions, 2)
    assert.equal(questionAnswers, 1)
    assert.equal(queued, true)
    assert.equal(maximumActive, 2)
    assert(
      calls.filter((call) => call.child).every((call) => call.shared),
      'Children must receive common requirements'
    )
    assert(
      calls.some((call) => call.tools.includes('question')),
      'Native question tool must be advertised'
    )
    await turn('DISMISS_PARENT: complete the same synthetic task after a clarification is dismissed.')
    await turn('ROOT_QUESTION_DISMISS_PARENT: continue after the parent question is skipped.')
    await turn('FILE_MCP_PARENT: write the isolated test file and call the selected lookup tool.')
    assert.equal(approvedExternalCalls, 1)
    assert.equal(externalCalls, 1)
    assert.equal(await readFile(file, 'utf8'), 'Checked replacement\n')
    const records = await fileStore.list()
    assert.equal(records.length, 1, 'The native writer must produce one verified change')
    assert.equal(
      await fileStore.restore(records[0].id, [workspace], async () => assert.fail('expected restore')),
      'restored'
    )
    assert.equal(await readFile(file, 'utf8'), 'Synthetic local audit fixture.\n')
    foreignChild = (
      await client.request<Array<{ id: string; title: string }>>(`/session/${firstParent}/children`)
    ).find((item) => item.title.includes('@general'))!.id
    const beforeOwnedResume = calls.filter((call) => call.child).length
    await turn('OWN_PARENT: continue an existing child in this conversation.', false, firstParent)
    assert.equal(
      calls.filter((call) => call.child).length,
      beforeOwnedResume + 2,
      'An owned child must remain resumable'
    )
    const childRequestsBefore = calls.filter((call) => call.child).length
    await turn('CROSS_PARENT: attempt to resume a child from a different conversation.')
    assert.equal(
      calls.filter((call) => call.child).length,
      childRequestsBefore,
      'A foreign child must never be resumed'
    )
    const backgroundParent = await turn('BACKGROUND_PARENT: delegate and continue while the child works.')
    const backgroundHistory = await client.request<Array<{ info: any; parts: any[] }>>(
      `/session/${backgroundParent}/message`
    )
    assert.equal(parentIdleBeforeChild, true, 'Parent must finish its independent work while child is running')
    assert.equal(backgroundResultWithRules, true, 'Native result follow-up must retain Zen instructions')
    assert(backgroundHistory.at(-1)?.parts.some((part) => part.text?.includes('Integrated background finding.')))
    await turn('CANCEL_PARENT: start a child to test stopping.', 'session')
    // Hold the background child once its parent has gone idle, then stop the runtime as the desktop Stop action does.
    await turn('BACKGROUND_STOP_PARENT: start a detached child to test stopping.', 'runtime')
    const response = await waitForModelRequest(backgroundStop.promise)
    const closed = once(response, 'close', { signal: AbortSignal.timeout(5000) })
    assert(child.kill(), 'Runtime must accept termination')
    await closed
    process.stdout.write(
      `PASS native ${OPENCODE_VERSION}: background result integration and shutdown, bounded subagents, question continuation, parent cancellation, file restoration, and selected MCP approval.\n`
    )
  } finally {
    clearTimeout(timer)
    controller.abort('Test complete')
    await fileTurn.close()
    child.kill()
    provider.closeAllConnections()
    await new Promise<void>((resolve) => provider.close(() => resolve()))
  }
}
main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
