import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { TOPIC_NAMING_REQUEST_HEADERS } from '../../packages/shared/diagnostics'
import { listenOnLoopback } from '../../packages/shared/utils/loopbackServer'
import {
  attachFiles,
  checkToolOutput,
  closeIsolated,
  launchIsolated,
  openEntry,
  prepareToolFixture,
  readMessages,
  seedModel,
  sendUI,
  verifyIsolatedPython,
  within
} from './electron'
import { startBudgetGateway } from './gateway'
import { DEFAULT_OUTPUT_TOKENS_PER_REQUEST, RequestBudget } from './live'
import { createFileTaskPermissionGuard } from './native-write-permission'
import { MoneyBudget, validatePrice } from './pricing'
import { prepareQualityPython } from './python-runtime'
import { quick } from './scenarios'

export async function uiSmoke(
  root: string,
  directory: string,
  signal?: AbortSignal,
  options: {
    namingFailure?: 'http' | 'timeout'
    toolPath?: 'file-tools' | 'shell-fallback' | 'python-cwd-fallback' | 'managed-python'
    browserPrivate?: boolean
  } = {}
) {
  const namingFailure = options.namingFailure ?? 'http'
  const shellFallback = options.toolPath === 'shell-fallback'
  const pythonCwdFallback = options.toolPath === 'python-cwd-fallback'
  const managedPython = options.toolPath === 'managed-python'
  let python: Awaited<ReturnType<typeof prepareQualityPython>> | undefined
  let cleanupConfirmed = true
  const outputReserve = pythonCwdFallback ? DEFAULT_OUTPUT_TOKENS_PER_REQUEST : 1000
  let sequence = 0
  let transientFailures = 0
  let nativeRetryRecovered = false
  let toolFixture: Awaited<ReturnType<typeof prepareToolFixture>> | undefined
  let toolStep = 0
  let browserStep = 0
  let privatePageOpened = false
  const attachmentEntries = new Set<string>()
  const namingEntries = new Set<string>()
  const fixtureErrors: string[] = []
  const mock = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/quality-private-page') {
        privatePageOpened = true
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><title>Local shutdown fixture</title><p>PRIVATE-BROWSER-7319</p>')
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (request.top_p !== undefined) throw new Error('自动化测试未关闭Top-P，实际模型请求仍携带top_p参数。')
      if (req.headers['x-zen-request-purpose'] === TOPIC_NAMING_REQUEST_HEADERS['X-Zen-Request-Purpose']) {
        sequence++
        // Keep the socket open until the product's real 15-second naming deadline.
        // A quick HTTP error alone does not exercise TimeoutError -> diagnostics.
        if (namingFailure === 'timeout') return
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'QUALITY_EXPECTED_NAMING_FAILURE' } }))
        return
      }
      const latestUser = request.messages?.findLast((message: any) => message.role === 'user')
      if (JSON.stringify(latestUser).includes('QUALITY_EXPECTED_TERMINAL_400')) {
        sequence++
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'QUALITY_EXPECTED_TERMINAL_400' } }))
        return
      }
      if (request.tools?.length && JSON.stringify(latestUser).includes('更正一下') && !transientFailures) {
        transientFailures++
        sequence++
        res.writeHead(503, { 'content-type': 'application/json', 'x-request-id': 'quality-native-retry-503' })
        res.end(JSON.stringify({ error: { message: '本地模拟：服务暂时不可用' } }))
        return
      }
      const nativeTask =
        toolFixture && request.tools?.length && JSON.stringify(latestUser).includes('quality-source.json')
      let delta: Record<string, unknown> = {
        role: 'assistant',
        content: '你好，已理解。更正后总预算5500元，备用金2000元，可用活动费用3500元。'
      }
      if (JSON.stringify(latestUser).includes('附件传输验证')) {
        // The user prompt deliberately does not name the file. It must arrive through real upload handling.
        if (!JSON.stringify(latestUser).includes('quality-upload-verify.json'))
          throw new Error('附件没有通过产品上传链路到达模型请求。')
        attachmentEntries.add(request.tools?.length ? 'assistant' : 'chat')
      }
      if (nativeTask && managedPython) {
        if (toolStep === 0) {
          const name = request.tools.find((tool: any) => tool.function?.name?.endsWith('__python_execute'))?.function
            .name
          assert(name, 'The real managed Python tool is missing')
          const code = [
            'import json, pathlib',
            `source = pathlib.Path(${JSON.stringify(toolFixture!.source)})`,
            `output = pathlib.Path(${JSON.stringify(toolFixture!.output)})`,
            "total = sum(json.loads(source.read_text(encoding='utf-8'))['amounts'])",
            "output.write_text(str(total), encoding='utf-8')",
            "print('QUALITY_MANAGED_PYTHON_OK')"
          ].join('\n')
          delta = {
            tool_calls: [
              {
                index: 0,
                id: 'quality-managed-python',
                type: 'function',
                function: { name, arguments: JSON.stringify({ code }) }
              }
            ]
          }
          toolStep++
        } else {
          assert(
            request.messages.some(
              (message: any) =>
                message.role === 'tool' && JSON.stringify(message.content).includes('QUALITY_MANAGED_PYTHON_OK')
            ),
            'The real Python execution did not succeed'
          )
        }
      } else if (nativeTask && toolStep < (shellFallback || pythonCwdFallback ? 3 : 2)) {
        const readStep = shellFallback || pythonCwdFallback ? 1 : 0
        if (pythonCwdFallback && toolStep === 1) {
          assert(
            request.messages.some(
              (message: any) =>
                message.role === 'tool' &&
                JSON.stringify(message.content).includes('Invalid working_directory') &&
                JSON.stringify(message.content).includes('Omit working_directory')
            ),
            'The real Python tool did not reject the outside cwd with recovery guidance'
          )
        }
        if (shellFallback && toolStep === 1) {
          assert(
            request.messages.some(
              (message: any) => message.role === 'tool' && /reject|denied|拒绝/i.test(JSON.stringify(message.content))
            ),
            '未通过真实权限界面拒绝命令行工具。'
          )
          await assert.rejects(lstat(path.join(toolFixture!.workspace, 'quality-unapproved-shell.txt')), {
            code: 'ENOENT'
          })
        }
        const name =
          shellFallback && toolStep === 0
            ? 'bash'
            : pythonCwdFallback && toolStep === 0
              ? request.tools.find((tool: any) => tool.function?.name?.endsWith('__python_execute'))?.function.name
              : toolStep === readStep
                ? 'read'
                : request.tools.find((tool: any) => tool.function?.name?.endsWith('__create_file'))?.function.name
        if (
          toolStep === readStep + 1 &&
          !request.messages.some(
            (message: any) => message.role === 'tool' && JSON.stringify(message.content).includes('amounts')
          )
        )
          throw new Error('实际read工具没有返回源文件内容。')
        if (!request.tools.some((tool: any) => tool.function?.name === name))
          throw new Error(`实际助手未提供${name}工具，不能模拟跳过。`)
        const args =
          shellFallback && toolStep === 0
            ? {
                command: `echo QUALITY_SHELL_MUST_NOT_RUN > "${path.join(toolFixture!.workspace, 'quality-unapproved-shell.txt')}"`,
                description: '本地验收：此命令必须被拒绝，不能执行'
              }
            : pythonCwdFallback && toolStep === 0
              ? {
                  code: 'raise RuntimeError("QUALITY_PYTHON_MUST_NOT_RUN")',
                  working_directory: path.dirname(toolFixture!.workspace)
                }
              : toolStep === readStep
                ? { filePath: toolFixture!.source }
                : { file_path: toolFixture!.output, content: '合计：21' }
        toolStep++
        delta = {
          tool_calls: [
            {
              index: 0,
              id: `quality-tool-${toolStep}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) }
            }
          ]
        }
      }
      if (request.tools?.length && JSON.stringify(latestUser).includes('QUALITY_BROWSER_SHUTDOWN')) {
        if (!browserStep++) {
          const name = request.tools.find((tool: any) => tool.function?.name?.endsWith('browser__open'))?.function.name
          assert(name, 'Real browser open tool is missing')
          delta = {
            tool_calls: [
              {
                index: 0,
                id: 'quality-private-browser',
                type: 'function',
                function: {
                  name,
                  arguments: JSON.stringify({
                    url: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/quality-private-page`,
                    privateMode: true,
                    format: 'txt',
                    showWindow: false
                  })
                }
              }
            ]
          }
        } else {
          assert(privatePageOpened, 'The real browser never loaded the local page')
          assert(
            request.messages.some(
              (message: any) =>
                message.role === 'tool' && JSON.stringify(message.content).includes('PRIVATE-BROWSER-7319')
            ),
            'Private browser tool did not return the local page content'
          )
          delta = { content: 'PRIVATE-BROWSER-7319，已读取本地测试页面。' }
        }
      }
      const payload = {
        id: `local-mock-${++sequence}`,
        created: 1,
        object: 'chat.completion',
        model: 'gpt-quality-fixture',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '你好，已理解。更正后总预算5500元，备用金2000元，可用活动费用3500元。'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 10000,
          completion_tokens: pythonCwdFallback && nativeTask && toolStep === 1 ? 5033 : 40,
          total_tokens: pythonCwdFallback && nativeTask && toolStep === 1 ? 15033 : 10040,
          completion_tokens_details:
            pythonCwdFallback && nativeTask && toolStep === 1 ? { reasoning_tokens: 4687 } : undefined,
          prompt_tokens_details: { cached_tokens: 8000 }
        }
      }
      res.setHeader('content-type', request.stream ? 'text/event-stream' : 'application/json')
      res.end(
        request.stream
          ? `data: ${JSON.stringify({ ...payload, object: 'chat.completion.chunk', usage: undefined, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...payload, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`
          : JSON.stringify(payload)
      )
    } catch (error) {
      fixtureErrors.push(String(error))
      res.writeHead(500).end(JSON.stringify({ error: { message: 'Local fixture assertion failed' } }))
    }
  })
  await listenOnLoopback(mock)
  const price = validatePrice({
    providerRef: 'local',
    modelId: 'gpt-quality-fixture',
    currency: 'CNY',
    basis: 'key-charge',
    source: 'cost-free loopback fixture',
    group: 'test',
    capturedAt: '2020-01-01T00:00:00Z',
    validUntil: '2099-01-01T00:00:00Z',
    tiers: [{ throughInputTokens: 200000, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }]
  })
  const results: unknown[] = []
  try {
    if (managedPython) python = await prepareQualityPython(root, directory, signal)
    for (const entry of ['chat', 'assistant']) {
      if (signal?.aborted) throw new Error('已取消')
      const targetDir = path.join(directory, entry)
      await mkdir(targetDir, { recursive: true })
      const gateway = await startBudgetGateway({
        baseURL: `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`,
        modelId: 'gpt-quality-fixture',
        credential: 'local-cost-free',
        price,
        money: new MoneyBudget(10),
        tokens: new RequestBudget({
          maxRequests: 20,
          maxInputTokens: 4000000,
          maxOutputTokens: pythonCwdFallback ? 60000 : 20000
        }),
        maxInput: 200000,
        maxOutput: outputReserve,
        timeoutMs: 30000,
        signal
      })
      let instance: Awaited<ReturnType<typeof launchIsolated>> | undefined
      try {
        instance = await launchIsolated(root, targetDir, signal, entry === 'assistant' ? python : undefined)
        if (entry === 'assistant' && python) await verifyIsolatedPython(instance.page, python)
        instance.page.on('response', (response) => {
          if (
            !response.url().includes('/messages') ||
            !response.headers()['content-type']?.includes('text/event-stream')
          )
            return
          response
            .body()
            .then((data) => writeFile(path.join(targetDir, `stream-${Date.now()}.log`), data))
            .catch(() => {})
        })
        // Reproduce a pre-existing non-default Top-P; test setup must disable it before any request.
        await instance.page.evaluate(() => {
          const store = (window as any).store
          const assistant = store.getState().assistants.assistants[0]
          store.dispatch({
            type: 'assistants/updateAssistant',
            payload: { id: assistant.id, settings: { ...assistant.settings, enableTopP: true, topP: 0.4 } }
          })
        })
        await seedModel(instance.page, {
          url: gateway.url,
          token: gateway.token,
          modelId: 'gpt-quality-fixture',
          maxOutput: outputReserve
        })
        await openEntry(instance.page, entry)
        const settleTurn = async (turnId: string) => {
          const deadline = performance.now() + 30000
          let quietAt = performance.now()
          let count = gateway.calls.length
          while (performance.now() < deadline) {
            if (signal?.aborted) throw new Error('已取消')
            if (!gateway.isIdle() || count !== gateway.calls.length) {
              quietAt = performance.now()
              count = gateway.calls.length
            }
            if (gateway.isIdle() && performance.now() - quietAt >= 1200) {
              gateway.assertTurnHealthy(turnId)
              return
            }
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          throw new Error('模拟自动命名调用未结束。')
        }
        for (const scenario of quick) {
          gateway.beginTurn(`${entry}-${scenario.id}`)
          const turnId = `${entry}-${scenario.id}`
          const result = await sendUI(instance.page, scenario.prompt, 60000, signal, {
            checkFailure: () => gateway.assertTurnHealthy(turnId, true)
          })
          await settleTurn(turnId)
          if (entry === 'assistant' && scenario.id === 'quick-02') {
            const attempts = gateway.calls.filter((call) => call.turnId === turnId)
            nativeRetryRecovered =
              attempts.some((call) => call.status === 503) && attempts.some((call) => call.completed)
            if (!nativeRetryRecovered) throw new Error('没有验证原生503重试恢复。')
          }
          if (!result.answer.includes('3500') || !result.answer.includes('你好'))
            throw new Error('页面/消息状态缺少完整UTF-8模拟回答。')
          results.push({ entry, caseId: scenario.id, ...result, warnings: gateway.turnWarnings(turnId) })
        }
        if (!gateway.calls.some((call) => call.purpose === 'topic-naming' && call.failureImpact === 'warning'))
          throw new Error('未验证实际自动命名失败不影响主回答/后续轮次。')
        if (
          namingFailure === 'timeout' &&
          !gateway.calls.some(
            (call) => call.purpose === 'topic-naming' && call.status === null && call.error?.includes('cancelled')
          )
        )
          throw new Error('未验证实际15秒命名超时取消链路。')
        namingEntries.add(entry)
        if (entry === 'assistant') {
          toolFixture = await prepareToolFixture(instance.page, instance.instance)
          const permissionGuard = await createFileTaskPermissionGuard(instance.page, instance.instance, toolFixture)
          gateway.beginTurn('assistant-tool')
          const result = await sendUI(instance.page, toolFixture.prompt, 60000, signal, {
            checkFailure: async () => {
              gateway.assertTurnHealthy('assistant-tool', true)
              await permissionGuard.checkPermission()
            }
          })
          await checkToolOutput(toolFixture)
          if (toolStep !== (managedPython ? 1 : shellFallback || pythonCwdFallback ? 3 : 2))
            throw new Error('工具闭环未完成。')
          if (pythonCwdFallback) {
            assert(
              gateway.calls.some(
                (call) => call.turnId === 'assistant-tool' && call.usage?.output === 5033 && !call.error
              ),
              'The 5,033-token reasoning completion was not accepted within the approved 8,192-token reserve'
            )
          }
          if (shellFallback) {
            assert.equal(permissionGuard.approved.length, 0)
            assert.equal(permissionGuard.denied.length, 1)
            assert.equal(permissionGuard.denied[0].toolName, 'bash')
            await assert.rejects(lstat(path.join(toolFixture.workspace, 'quality-unapproved-shell.txt')), {
              code: 'ENOENT'
            })
          }
          results.push({
            entry,
            caseId: 'tool',
            ...result,
            nativeWriteApprovals: permissionGuard.approved,
            deniedPermissions: permissionGuard.denied
          })
        }
        const source = path.join(instance.instance, 'quality-upload-verify.json')
        const content = JSON.stringify({ note: '合成附件传输验证', id: 'ATTACH-7319', amounts: [120, 230, 350] })
        await writeFile(source, content, { flag: 'wx' })
        await attachFiles(instance, [source], entry)
        gateway.beginTurn(`${entry}-attachment-transport`)
        const result = await sendUI(
          instance.page,
          '附件传输验证：仅确认收到本轮上传的附件，不要创建文件。',
          60000,
          signal
        )
        const file = await instance.page.evaluate(() => {
          const blocks = (window as any).store.getState().messageBlocks.entities
          return Object.values(blocks).find(
            (block: any) => block?.file?.origin_name === 'quality-upload-verify.json'
          ) as any
        })
        if (!file?.file?.path || !file.file.id) throw new Error('真实消息没有保留附件记录。')
        within(instance.instance, file.file.path)
        if ((await readFile(file.file.path, 'utf8')) !== content || (await readFile(source, 'utf8')) !== content)
          throw new Error('附件上传内容或原文件不一致。')
        if (!attachmentEntries.has(entry)) throw new Error('本入口缺少附件到达模型请求的证据。')
        results.push({ entry, caseId: 'attachment-transport', ...result, attachmentContentVerified: true })
        if (entry === 'assistant' && options.browserPrivate) {
          gateway.beginTurn('assistant-private-browser-shutdown')
          const result = await sendUI(
            instance.page,
            'QUALITY_BROWSER_SHUTDOWN：请用隐私浏览器读取本地测试页面，仅返回识别码，不创建文件。',
            60000,
            signal
          )
          assert(privatePageOpened && browserStep >= 2, 'Missing real private browser round trip')
          results.push({ entry, caseId: 'private-browser-shutdown', ...result })
        }
        if (entry === 'chat') {
          gateway.beginTurn('chat-expected-terminal-error')
          const failure = await sendUI(instance.page, 'QUALITY_EXPECTED_TERMINAL_400', 30000, signal).then(
            () => '',
            (error: unknown) => String(error)
          )
          if (!failure.includes('QUALITY_EXPECTED_TERMINAL_400'))
            throw new Error(`未验证不可重试错误的最终失败状态：${failure}`)
          results.push({ entry, caseId: 'expected-terminal-error', expectedFailure: true, detail: failure })
        }
        await instance.page.screenshot({ path: path.join(targetDir, 'completed.png') })
      } catch (error) {
        if ((error as { isolationCleanupUnconfirmed?: boolean }).isolationCleanupUnconfirmed) cleanupConfirmed = false
        if (instance) {
          await writeFile(
            path.join(targetDir, 'failure-messages.json'),
            JSON.stringify(await readMessages(instance.page), null, 2)
          ).catch(() => {})
          await writeFile(
            path.join(targetDir, 'failure-blocks.json'),
            JSON.stringify(await instance.page.evaluate(() => (window as any).store.getState().messageBlocks), null, 2)
          ).catch(() => {})
          await writeFile(
            path.join(targetDir, 'failure-dom.txt'),
            await instance.page
              .locator('body')
              .innerText()
              .catch(() => 'page unavailable')
          )
          await instance.page.screenshot({ path: path.join(targetDir, 'failed.png') }).catch(() => {})
        }
        throw error
      } finally {
        try {
          if (instance) await closeIsolated(instance.application)
        } catch (error) {
          cleanupConfirmed = false
          throw error
        } finally {
          await gateway.close()
          await writeFile(
            path.join(targetDir, 'calls.json'),
            JSON.stringify({ calls: gateway.calls, rejected: gateway.rejected }, null, 2)
          )
        }
      }
    }
    await writeFile(
      path.join(directory, 'ui-results.json'),
      JSON.stringify(
        {
          paidRequests: 0,
          toolPath: options.toolPath ?? 'file-tools',
          reasoningOutputAndCwdRecoveryVerified: pythonCwdFallback || undefined,
          managedPythonVerified: managedPython || undefined,
          privateBrowserVerified: options.browserPrivate ? privatePageOpened && browserStep >= 2 : undefined,
          driver: 'actual Electron development UI + loopback only',
          requestParameters: { topP: 'omitted', requestsChecked: sequence },
          nativeRetry: { transientFailures, recovered: nativeRetryRecovered },
          namingFailure: {
            mode: namingFailure,
            entries: [...namingEntries],
            mainAndLaterTurnsPassed: namingEntries.size === 2
          },
          results
        },
        null,
        2
      )
    )
    if (fixtureErrors.length) throw new Error(fixtureErrors.join(';'))
    process.stdout.write(
      `PASS quality isolated Electron UI: ${options.browserPrivate ? 8 : 7} successful turns + 1 expected terminal error, 2 entries, naming ${namingFailure} failure warning + later turns passed, native 503 retry recovered, Top-P omitted, real attachment upload + ${shellFallback ? 'shell denied through UI + fallback ' : ''}${pythonCwdFallback ? 'reasoning output 5033/8192 + Python cwd rejected and safe recovery + ' : ''}${managedPython ? 'real MCP Zen Python execution' : 'native read + MCP create_file'} + independent output check${options.browserPrivate ? ' + real private browser round trip and shutdown' : ''}, 0 paid requests\n`
    )
  } finally {
    try {
      mock.closeAllConnections()
      await new Promise<void>((resolve) => mock.close(() => resolve()))
    } finally {
      if (python && cleanupConfirmed) await python.release()
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const directory = path.resolve('local/quality-reports', `ui-${Date.now()}`)
  mkdir(directory, { recursive: true })
    .then(() =>
      uiSmoke(path.resolve(__dirname, '../..'), directory, undefined, {
        namingFailure: process.argv.includes('--naming-timeout') ? 'timeout' : 'http',
        toolPath: process.argv.includes('--tool-managed-python')
          ? 'managed-python'
          : process.argv.includes('--tool-python-cwd')
            ? 'python-cwd-fallback'
            : process.argv.includes('--tool-shell-fallback')
              ? 'shell-fallback'
              : 'file-tools',
        browserPrivate: process.argv.includes('--browser-private')
      })
    )
    .catch((error) => {
      process.stderr.write(String(error) + `\n证据：${directory}\n`)
      process.exitCode = 1
    })
}
