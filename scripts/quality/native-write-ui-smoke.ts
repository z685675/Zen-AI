// Cost-free regression: real Electron UI -> product API -> OpenCode native read/write.
// Only the model transport is simulated. Permissions are never auto-approved.
import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'

import type { Page } from '@playwright/test'

import { listenOnLoopback } from '../../packages/shared/utils/loopbackServer'
import {
  assistantWorkspace,
  closeIsolated,
  launchIsolated,
  openEntry,
  readMessages,
  seedModel,
  sendUI,
  within
} from './electron'
import { createNativeWritePermissionGuard, visibleNativeWritePermissionCard } from './native-write-permission'

type Case = { id: string; decision: 'allow' | 'deny' | 'cancel'; target: string }
type Permission = {
  requestId: string
  toolCallId: string
  toolName: string
  status: string
  input: Record<string, unknown>
  autoApprove?: boolean
  suggestions: unknown[]
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const state = (window as any).store.getState()
    return {
      permissions: Object.values(state.toolPermissions.requests) as Permission[],
      blocks: Object.values(state.messageBlocks.entities).filter(Boolean) as any[],
      events: (window as any).__nativePermissionEvidence,
      messages: Object.values(state.messages.entities).filter(Boolean) as any[]
    }
  })
}

async function absent(file: string) {
  await assert.rejects(lstat(file), { code: 'ENOENT' }, `Unapproved file already exists: ${file}`)
}

async function waitUntil<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, ms = 15000) {
  const deadline = performance.now() + ms
  while (performance.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(label)
}

export async function nativeWriteUISmoke(root: string, directory: string) {
  const fixtureErrors: string[] = []
  const calls: Array<{ caseId: string; step: string; tools: string[] }> = []
  const results: unknown[] = []
  let instance: Awaited<ReturnType<typeof launchIsolated>> | undefined
  let source = ''
  let sourceContent = ''
  let current: Case | undefined
  let primaryError: unknown
  const mock = createServer(async (req, res) => {
    try {
      if (req.url === '/v1/models' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'zen-native-permission', object: 'model', owned_by: 'local-fixture' }]
          })
        )
        return
      }
      assert.equal(req.url, '/v1/chat/completions', 'Unexpected model endpoint')
      assert.equal(req.headers.authorization, 'Bearer local-native-permission-only')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.equal(body.model, 'zen-native-permission')
      assert(current, 'No UI case is active')
      const userIndex = body.messages.findLastIndex(
        (message: any) =>
          message.role === 'user' && JSON.stringify(message).includes(`NATIVE_PERMISSION:${current!.id}`)
      )
      const toolResults = body.messages.slice(userIndex + 1).filter((message: any) => message.role === 'tool')
      const tools = (body.tools ?? []).map((tool: any) => tool.function?.name)
      const step = !tools.length
        ? 'auxiliary'
        : toolResults.length === 0
          ? 'read'
          : toolResults.length === 1
            ? 'write'
            : 'final'
      if (step !== 'auxiliary') assert(userIndex >= 0, 'The real UI prompt did not reach the local model')
      calls.push({ caseId: current.id, step, tools })
      assert(calls.length <= 24, 'Local request budget exhausted')
      if (step === 'write' || step === 'final') {
        assert(JSON.stringify(toolResults[0].content).includes('amounts'), 'Real native read output is missing')
        assert(JSON.stringify(toolResults[0].content).includes('NATIVE-SOURCE-7319'), 'Native read returned wrong data')
      }
      let delta: Record<string, unknown>
      if (step === 'auxiliary') {
        delta = { content: 'Native permission regression' }
      } else if (step === 'final') {
        assert.notEqual(current.decision, 'cancel', 'Cancelled turn continued to call the model')
        const result = String(toolResults[1].content)
        if (current.decision === 'deny') assert.match(result, /reject|denied|拒绝|取消/i)
        else assert.doesNotMatch(result, /Error:|rejected|denied/i)
        delta = {
          content: `NATIVE_DONE:${current.id}，${current.decision === 'allow' ? '合计21，已保存' : '已拒绝，原件未修改'}`
        }
      } else {
        assert(tools.includes(step), `Native ${step} is unavailable; MCP substitution is forbidden`)
        delta = {
          tool_calls: [
            {
              index: 0,
              id: `native-${current.id}-${step}`,
              type: 'function',
              function: {
                name: step,
                arguments: JSON.stringify(
                  step === 'read'
                    ? { filePath: source }
                    : { filePath: current.target, content: '合计：21\nNATIVE-OUTPUT-7319\n' }
                )
              }
            }
          ]
        }
      }
      const payload = {
        id: `local-native-${calls.length}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model
      }
      if (step === 'auxiliary' && !body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            ...payload,
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', ...delta }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          })
        )
        return
      }
      assert.equal(body.stream, true, 'Expected real streaming product request')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        `data: ${JSON.stringify({ ...payload, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...payload, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 40, total_tokens: 2040 } })}\n\ndata: [DONE]\n\n`
      )
    } catch (error) {
      fixtureErrors.push(String(error))
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  const port = await listenOnLoopback(mock)
  try {
    instance = await launchIsolated(root, directory)
    const { page } = instance
    await page.evaluate(() => {
      const events: unknown[] = []
      ;(window as any).__nativePermissionEvidence = events
      for (const channel of ['agent-tool-permission:request', 'agent-tool-permission:result']) {
        ;(window as any).electron.ipcRenderer.on(channel, (_event: unknown, payload: unknown) =>
          events.push({ channel, payload })
        )
      }
    })
    await seedModel(page, {
      url: `http://127.0.0.1:${port}/v1`,
      token: 'local-native-permission-only',
      modelId: 'zen-native-permission',
      maxOutput: 1000
    })
    await openEntry(page, 'assistant')
    // Choose Execute through the real composer (never bypassPermissions).
    await page
      .locator('#inputbar')
      .getByRole('button', { name: /当前模式|Current Mode/i })
      .click()
    await page.getByRole('button', { name: /^执行\s|^Execute\s/i }).click()
    const workspace = await assistantWorkspace(page, instance.instance)
    source = path.join(workspace, 'native-source.json')
    sourceContent = JSON.stringify({ amounts: [3, 7, 11], marker: 'NATIVE-SOURCE-7319' })
    await writeFile(source, sourceContent, { flag: 'wx' })
    const cases: Case[] = [
      { id: 'once', decision: 'allow', target: path.join(workspace, 'native-once.txt') },
      { id: 'protect-original', decision: 'deny', target: source },
      { id: 'cancel', decision: 'cancel', target: path.join(workspace, 'native-cancelled.txt') },
      { id: 'after-cancel', decision: 'allow', target: path.join(workspace, 'native-after-cancel.txt') },
      { id: 'shutdown-pending', decision: 'cancel', target: path.join(workspace, 'native-shutdown.txt') }
    ]
    for (const item of cases) {
      current = item
      within(await realpath(workspace), item.target)
      if (item.target !== source) await absent(item.target)
      const before = new Set((await readMessages(page)).map((message) => message.id))
      // Attach a rejection handler immediately: cancellation is an expected terminal state.
      const completion = sendUI(
        page,
        `NATIVE_PERMISSION:${item.id}。用原生read读取${source}，再用原生write写入${item.target}，合计21。禁止MCP、命令、其他路径；若拒绝不要重试。`,
        45000,
        undefined,
        {
          checkFailure: () => {
            if (fixtureErrors.length) throw new Error(fixtureErrors.join('; '))
          }
        }
      ).then(
        (value) => ({ value, error: '' }),
        (error: unknown) => ({ value: undefined, error: String(error) })
      )
      const pending = await waitUntil(
        () => snapshot(page),
        (value) => value.permissions.some((permission) => permission.status === 'pending'),
        `No visible permission request for ${item.id}; inspect failure-state.json for IPC/tool ID mismatch`
      )
      assert.equal(pending.permissions.length, 1, 'Refuse to approve multiple/unknown requests')
      const request = pending.permissions[0]
      assert.equal(request.autoApprove, undefined)
      assert.equal(request.suggestions.length, 0, 'Native write must not offer persistent/wildcard approval')
      const blocks = pending.blocks.filter((block) => !before.has(block.messageId))
      const toolBlock = blocks.find((block) => block.metadata?.rawMcpToolResponse?.toolCallId === request.toolCallId)
      assert(toolBlock, `Permission/tool ID mismatch: ${request.toolCallId}`)
      const tool = toolBlock.metadata.rawMcpToolResponse
      assert.equal(tool.tool.name, 'write', 'Permission does not belong to native write')
      assert.equal(path.resolve(tool.arguments.filePath), path.resolve(item.target))
      // OpenCode uses the native "edit" permission for write. Inspect metadata's exact filename, not '*'.
      assert.equal(request.toolName, 'edit')
      assert.equal(path.resolve(String(request.input.filepath)), path.resolve(item.target))
      assert.equal(await readFile(source, 'utf8'), sourceContent)
      if (item.target !== source) await absent(item.target)
      const header = page.locator('[data-tool-permission-header]').filter({ visible: true })
      await header.waitFor({ state: 'visible', timeout: 5000 })
      assert.equal(await header.getAttribute('data-tool-call-id'), request.toolCallId)
      const groupHeader = header.locator('xpath=ancestor::*[@aria-expanded][1]')
      if (item.id === 'once') {
        if ((await groupHeader.getAttribute('aria-expanded')) === 'true')
          await groupHeader.locator('.ant-collapse-expand-icon').click()
        assert((await header.innerText()).includes(item.target), 'Collapsed header hides native file path')
        assert.equal(await header.getByRole('button', { name: /^(运\s*行|Run)$/i }).count(), 1)
        await page.screenshot({ path: path.join(directory, 'once-collapsed.png') })
      } else {
        await visibleNativeWritePermissionCard(page, request, item.target)
      }
      await page.screenshot({ path: path.join(directory, `${item.id}-pending.png`) })
      await writeFile(path.join(directory, `${item.id}-pending.json`), JSON.stringify(pending, null, 2))
      // Observe an actual human-wait interval; no output is created before the explicit click.
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const stillPending = await snapshot(page)
      assert.equal(stillPending.permissions[0]?.requestId, request.requestId)
      assert.equal(stillPending.permissions[0]?.status, 'pending')
      if (item.target !== source) await absent(item.target)
      if (item.id === 'shutdown-pending') {
        const child = instance.application.process()
        try {
          await closeIsolated(instance.application)
        } catch (error) {
          await writeFile(
            path.join(directory, 'shutdown-failure.json'),
            JSON.stringify(
              {
                exit: child.exitCode,
                signal: child.signalCode,
                error: error instanceof Error ? error.stack : String(error)
              },
              null,
              2
            )
          )
          throw error
        }
        instance = undefined
        await completion
        assert.equal(child.exitCode, 0, 'Pending permission cleanup did not exit normally')
        assert.equal(child.signalCode, null)
        assert.equal(await readFile(source, 'utf8'), sourceContent)
        await absent(item.target)
        results.push({ ...item, pendingRequestId: request.requestId, exit: child.exitCode, signal: child.signalCode })
        process.stdout.write('PASS native UI shutdown-pending: task stopped before close, exit 0, original preserved\n')
        break
      }
      if (item.decision === 'cancel') {
        await page
          .locator('#inputbar')
          .locator('button, [role="button"]')
          .filter({ has: page.locator('svg.lucide-circle-pause') })
          .click()
      } else if (item.decision === 'allow') {
        const guard = await createNativeWritePermissionGuard(page, instance.instance, {
          workspace,
          source,
          content: sourceContent,
          output: item.target
        })
        await guard.checkPermission()
        assert.equal(guard.approved.length, 1)
        assert.equal(guard.approved[0].expandedFromHeader, item.id === 'once')
        results.push({ caseId: item.id, strictGuard: guard.approved })
      } else {
        const { card } = await visibleNativeWritePermissionCard(page, request, item.target)
        await card.getByRole('button', { name: /^(取\s*消|Cancel)$/i }).click()
      }
      const done = await completion
      if (item.decision === 'cancel') {
        assert.match(done.error, /paused|停止|取消|aborted/i)
        await waitUntil(
          () => snapshot(page),
          (value) =>
            value.messages.some(
              (message) =>
                !before.has(message.id) &&
                message.role === 'assistant' &&
                message.providerMetadata?.responseTiming?.outcome === 'cancelled'
            ) &&
            value.blocks.some(
              (block) =>
                block.metadata?.rawMcpToolResponse?.toolCallId === request.toolCallId &&
                block.metadata.rawMcpToolResponse.status === 'cancelled'
            ),
          'Cancelled task remained processing'
        )
      } else {
        assert.equal(done.error, '')
        assert(done.value?.answer.includes(`NATIVE_DONE:${item.id}`))
      }
      await waitUntil(
        () => snapshot(page),
        (value) => value.permissions.length === 0,
        'Permission leaked after terminal turn'
      )
      assert.equal(await readFile(source, 'utf8'), sourceContent, 'Original file was modified')
      if (item.decision === 'allow') {
        const stat = await lstat(item.target)
        assert(stat.isFile() && !stat.isSymbolicLink() && stat.size < 1024)
        within(await realpath(workspace), await realpath(item.target))
        assert.equal(await readFile(item.target, 'utf8'), '合计：21\nNATIVE-OUTPUT-7319\n')
      } else if (item.target !== source) await absent(item.target)
      const evidence = await snapshot(page)
      const events = evidence.events as Array<{ channel: string; payload: any }>
      assert.equal(
        events.filter((event) => event.channel.endsWith(':request') && event.payload.requestId === request.requestId)
          .length,
        1,
        'Duplicate permission IPC'
      )
      const resolution = events.find(
        (event) => event.channel.endsWith(':result') && event.payload.requestId === request.requestId
      )?.payload
      assert.equal(resolution?.behavior, item.decision === 'allow' ? 'allow' : 'deny')
      assert.equal(resolution?.reason, item.decision === 'cancel' ? 'aborted' : 'response')
      await writeFile(path.join(directory, `${item.id}-terminal.json`), JSON.stringify(evidence, null, 2))
      results.push({
        ...item,
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        terminal: done,
        resolution
      })
      process.stdout.write(
        `PASS native UI ${item.id}: real read -> write, explicit ${item.decision}, original preserved\n`
      )
    }
    assert.equal(fixtureErrors.length, 0, fixtureErrors.join('; '))
    await writeFile(
      path.join(directory, 'native-write-results.json'),
      JSON.stringify(
        {
          paidRequests: 0,
          driver: 'actual isolated Electron UI + native OpenCode + loopback model',
          permissionMode: 'acceptEdits',
          results,
          calls
        },
        null,
        2
      )
    )
  } catch (error) {
    primaryError = error
    await writeFile(path.join(directory, 'failure-error.txt'), String(error))
    if (instance) {
      await writeFile(
        path.join(directory, 'failure-state.json'),
        JSON.stringify(await snapshot(instance.page), null, 2)
      ).catch(() => {})
      await writeFile(path.join(directory, 'failure-dom.txt'), await instance.page.locator('body').innerText()).catch(
        () => {}
      )
      await instance.page.screenshot({ path: path.join(directory, 'failed.png') }).catch(() => {})
    }
    throw error
  } finally {
    await writeFile(path.join(directory, 'model-calls.json'), JSON.stringify({ calls, fixtureErrors }, null, 2))
    try {
      if (instance)
        await closeIsolated(instance.application).catch((error) => {
          if (!primaryError) throw error
          process.stderr.write(`Cleanup (primary failure preserved): ${String(error)}\n`)
        })
    } finally {
      mock.closeAllConnections()
      await new Promise<void>((resolve) => mock.close(() => resolve()))
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const directory = path.resolve('local/quality-reports', `native-write-ui-${Date.now()}`)
  mkdir(directory, { recursive: true })
    .then(() => nativeWriteUISmoke(path.resolve(__dirname, '../..'), directory))
    .then(() =>
      process.stdout.write(
        `PASS native write UI: 5 permission cases including pending-task shutdown, 0 paid requests\nEvidence: ${directory}\n`
      )
    )
    .catch((error) => {
      process.stderr.write(`${String(error)}\nEvidence: ${directory}\n`)
      process.exitCode = 1
    })
}
