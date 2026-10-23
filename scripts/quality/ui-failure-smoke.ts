import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { listenOnLoopback } from '../../packages/shared/utils/loopbackServer'
import { closeIsolated, launchIsolated, readMessages, seedModel, sendUI } from './electron'
import { startBudgetGateway } from './gateway'
import { RequestBudget } from './live'
import { sanitizeEvidence } from './process'

/** Real renderer, SDK and error blocks; all upstream responses are owned loopback fixtures. */
export async function uiFailureSmoke(root: string, directory: string) {
  const results: unknown[] = []
  for (const mode of ['http500', 'empty', 'stream-error', 'partial-error']) {
    let requests = 0
    const server = createServer(async (req, res) => {
      for await (const chunk of req) {
        void chunk // Consume the synthetic request without retaining its body.
      }
      requests++
      if (mode === 'http500') {
        res
          .writeHead(500, { 'content-type': 'application/json' })
          .end('{"error":{"message":"status_code=500, upstream error: do request failed"}}')
        return
      }
      res.setHeader('content-type', 'text/event-stream')
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: 'owned-error-fixture', object: 'chat.completion.chunk', created: 1, model: 'gpt-quality-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      if (mode === 'partial-error') res.write(chunk({ content: '只收到部分回答' }))
      if (mode === 'stream-error' || mode === 'partial-error')
        res.end('data: {"error":{"message":"synthetic upstream stream failure"}}\n\n')
      else res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
    })
    await listenOnLoopback(server)
    const gateway = await startBudgetGateway({
      modelId: 'gpt-quality-fixture',
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      credential: 'owned-loopback-not-a-real-key',
      acknowledgedUnknownCost: true,
      tokens: new RequestBudget({ maxRequests: 10, maxInputTokens: 2000000, maxOutputTokens: 10000 }),
      maxInput: 200000,
      maxOutput: 1000,
      timeoutMs: 15000
    })
    const evidence = path.join(directory, mode)
    await mkdir(evidence, { recursive: true })
    let instance: Awaited<ReturnType<typeof launchIsolated>> | undefined
    try {
      instance = await launchIsolated(root, evidence)
      await seedModel(instance.page, {
        url: gateway.url,
        token: gateway.token,
        modelId: 'gpt-quality-fixture',
        maxOutput: 1000
      })
      gateway.beginTurn(mode)
      const started = performance.now()
      let error = ''
      try {
        // Do not use gateway fail-fast here: the product itself must display an error.
        await sendUI(instance.page, '请确认本次合成测试，不要使用工具。', 20000)
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure)
      }
      await instance.page
        .waitForFunction(
          () => {
            const state = (window as any).store.getState()
            return Object.values(state.messages.entities).some(
              (message: any) => message?.role === 'assistant' && message.status === 'error'
            )
          },
          undefined,
          { timeout: 5000 }
        )
        .catch(() => {})
      const messages = (await readMessages(instance.page)).filter((message) => message.role === 'assistant')
      const success =
        Boolean(error) && messages.some((message) => message.status === 'error' && message.error) && requests === 1
      await instance.page.screenshot({ path: path.join(evidence, 'error.png') })
      const result = {
        mode,
        success,
        error,
        durationMs: performance.now() - started,
        requests,
        messages,
        calls: gateway.calls
      }
      results.push(result)
      await writeFile(path.join(evidence, 'result.json'), JSON.stringify(sanitizeEvidence(result), null, 2))
      if (!success) throw new Error(`错误界面验收未通过：${mode}；证据：${evidence}`)
      process.stdout.write(`PASS ${mode}: error visible, one owned request, 0 paid requests\n`)
    } finally {
      await gateway.close()
      if (instance) await closeIsolated(instance.application)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await writeFile(
        path.join(directory, 'failure-smoke.json'),
        JSON.stringify(sanitizeEvidence({ paidRequests: 0, results }), null, 2)
      )
    }
  }
}
