import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { listenOnLoopback } from '../../packages/shared/utils/loopbackServer'
import { within } from './electron'
import { interactive } from './interactive'
import { fetchModels, selectModels } from './models'
import { runQuality } from './run'
import { uiFailureSmoke } from './ui-failure-smoke'

/** Zero-paid acceptance of the SAME approval/executor/report path used by live.
 * The endpoint is created here, never read from user settings or CLI arguments. */
export async function acceptanceSmoke(
  root: string,
  directory: string,
  profile: 'quick' | 'release' | 'mixed' | 'interactive' = 'quick'
) {
  let calls = 0
  let toolStep = 0
  let metadataCalls = 0
  const modelSteps = new Map<string, number>()
  const modelIds = ['mixed', 'interactive'].includes(profile)
    ? ['gemini-quality-fixture', 'claude-quality-fixture', 'grok-quality-fixture']
    : ['gpt-quality-fixture']
  const actualProfile = ['mixed', 'interactive'].includes(profile) ? 'quick' : profile
  const errors: string[] = []
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models') {
        metadataCalls++
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: modelIds.map((id) => ({ id })) }))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const user = request.messages.findLast((message: any) => message.role === 'user')?.content
      const text = typeof user === 'string' ? user : (user?.map((part: any) => part.text ?? '').join('\n') ?? '')
      const match = /请读取这个JSON文件：(.+?)。计算amounts的合计，把合计写到(.+?)，不要修改原文件。/.exec(text)
      let delta: Record<string, unknown> = {
        content:
          '你好，确认预算更正，活动可用3500元。项目ZX7319，负责人ZHOU，总预算5500元，口令MIDDLE4621，2026-12-18交付；原件不能覆盖。'
      }
      const step = modelSteps.get(request.model) ?? 0
      if (match && request.tools?.length && step < 2) {
        const source = within(root, path.resolve(match[1]))
        const output = within(root, path.resolve(match[2]))
        // No filesystem write by this fixture: only the real product tool may create output.
        if (
          step === 1 &&
          !request.messages.some(
            (message: any) => message.role === 'tool' && JSON.stringify(message.content).includes('amounts')
          )
        )
          throw new Error('Read did not return the source content')
        const name =
          step === 0
            ? 'read'
            : request.tools.find((tool: any) => tool.function?.name?.endsWith('__create_file'))?.function.name
        if (!name || !request.tools.some((tool: any) => tool.function?.name === name))
          throw new Error('Required actual native/MCP tool missing')
        const args = step === 0 ? { filePath: source } : { file_path: output, content: '合计：21' }
        modelSteps.set(request.model, step + 1)
        toolStep++
        delta = {
          tool_calls: [
            {
              index: 0,
              id: `fixture-tool-${toolStep}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) }
            }
          ]
        }
      }
      const base = { id: `fixture-${++calls}`, created: 1, model: request.model }
      const usage = {
        prompt_tokens: 10000,
        completion_tokens: 40,
        total_tokens: 10040,
        prompt_tokens_details: { cached_tokens: 8000 }
      }
      res.setHeader(
        'content-type',
        request.stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8'
      )
      res.end(
        request.stream
          ? `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage })}\n\ndata: [DONE]\n\n`
          : JSON.stringify({
              ...base,
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: '质检会话' }, finish_reason: 'stop' }],
              usage
            })
      )
    } catch (error) {
      errors.push(String(error))
      res.writeHead(500).end('{"error":{"message":"Local fixture failed"}}')
    }
  })
  await listenOnLoopback(server)
  const envName = 'ZEN_QUALITY_LOCAL_FIXTURE_KEY'
  const before = process.env[envName]
  try {
    process.env[envName] = 'owned-loopback-fixture-not-a-real-key'
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    if (profile === 'interactive') {
      const answers = [baseURL, '1,2,3']
      const credentialsBefore = new Set(Object.keys(process.env))
      const run = await interactive(['--pause-ms', '0'], root, undefined, {
        secret: async () => 'owned-loopback-fixture-not-a-real-key',
        ask: async () => {
          if (!answers.length) throw new Error('Unexpected extra interactive question')
          return answers.shift()!
        },
        // The smoke harness requires a prepared build; the public command always builds first.
        build: async () => {}
      })
      const report = JSON.parse(await readFile(path.join(run.directory, 'report.json'), 'utf8'))
      const cost = JSON.parse(await readFile(path.join(run.directory, 'cost-summary.json'), 'utf8'))
      const leaked = Object.keys(process.env).some(
        (key) => key.startsWith('ZEN_QUALITY_SESSION_') && !credentialsBefore.has(key)
      )
      const success =
        run.exitCode === 0 &&
        answers.length === 0 &&
        report.cases.length === 15 &&
        report.cases.every((item: any) => item.status === 'passed') &&
        toolStep === 6 &&
        metadataCalls === 1 &&
        cost.groups.length === 6 &&
        cost.unassignedCalls === 0 &&
        cost.groups.every((group: any) => group.all.estimatedAmount === null) &&
        !errors.length &&
        !leaked
      await writeFile(
        path.join(directory, 'local-smoke.json'),
        JSON.stringify(
          {
            paidRequests: 0,
            success,
            ownedMockCalls: calls,
            metadataCalls,
            toolSteps: toolStep,
            report: run.directory,
            leaked
          },
          null,
          2
        )
      )
      if (!success) throw new Error(`Interactive smoke failed; report: ${run.directory}`)
      process.stdout.write(
        `PASS quality interactive entry: 15 user turns, ${calls} owned loopback calls, key cleaned, 0 paid requests\n`
      )
      return
    }
    const chosen =
      profile === 'mixed' ? selectModels(await fetchModels({ baseURL, credentialEnv: envName }), '1,2,3') : undefined
    const file = path.join(directory, 'local-config.json')
    const config = {
      schemaVersion: 1,
      profile: actualProfile,
      allocation: profile === 'mixed' ? 'mixed' : 'all-models',
      ...(profile === 'release' ? { modules: ['history', 'memory'] } : {}),
      targets: chosen
        ? chosen.map((model) => ({
            family: model.family,
            providerRef: 'owned-loopback',
            modelId: model.id,
            entries: ['chat', 'assistant']
          }))
        : [
            {
              family: 'gpt',
              providerRef: 'owned-loopback',
              modelId: 'gpt-quality-fixture',
              entries: ['chat', 'assistant']
            }
          ],
      providers: [
        {
          providerRef: 'owned-loopback',
          baseURL,
          group: 'fixture',
          credentialEnv: envName
        }
      ],
      prices:
        profile === 'mixed'
          ? undefined
          : [
              {
                providerRef: 'owned-loopback',
                modelId: 'gpt-quality-fixture',
                currency: 'CNY',
                basis: 'key-charge',
                source: 'synthetic prices; real charge is zero',
                group: 'fixture',
                capturedAt: '2020-01-01T00:00:00Z',
                validUntil: '2099-01-01T00:00:00Z',
                tiers: [{ throughInputTokens: 200000, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }]
              }
            ],
      execution: { maxInputTokensPerRequest: 200000, requestTimeoutMs: 30000, turnTimeoutMs: 60000, pauseMs: 0 },
      budget: {
        mode: profile === 'mixed' ? 'tokens' : 'money',
        acknowledgedUnknownCost: profile === 'mixed' ? true : undefined,
        currency: profile === 'mixed' ? undefined : 'CNY',
        maxAmount: profile === 'mixed' ? undefined : 10,
        maxRequests: profile === 'quick' ? 20 : 60,
        maxOutputTokensPerRequest: 1000,
        maxInputTokens: profile === 'quick' ? 4000000 : 12000000,
        maxOutputTokens: profile === 'quick' ? 20000 : 60000,
        timeoutMs: profile === 'quick' ? 300000 : 900000
      }
    }
    await writeFile(file, JSON.stringify(config, null, 2), { flag: 'wx' })
    const options = { mode: 'live' as const, projects: ['ai' as const], dryRun: true, liveConfig: file }
    const preview = await runQuality(options, root)
    if (calls !== 0 || !preview.report.livePlan) throw new Error('Dry-run made a call / no plan')
    const plan = preview.report.livePlan as { executionAvailable: boolean; approvalDigest: string; userTurns: number }
    if (!plan.executionAvailable) throw new Error('Local fixture plan is blocked')
    const run = await runQuality({ ...options, dryRun: false, approval: plan.approvalDigest }, root)
    const cost = JSON.parse(await readFile(path.join(run.directory, 'cost-summary.json'), 'utf8'))
    const success =
      run.exitCode === 0 &&
      run.report.cases.length === plan.userTurns &&
      run.report.cases.every((item) => item.status === 'passed') &&
      toolStep === (profile === 'quick' ? 2 : profile === 'mixed' ? 6 : 0) &&
      (profile !== 'mixed' ||
        (metadataCalls === 1 &&
          cost.groups.length === 6 &&
          cost.groups.every((group: any) => group.all.estimatedAmount === null))) &&
      errors.length === 0 &&
      cost.unassignedCalls === 0
    await writeFile(
      path.join(directory, 'local-smoke.json'),
      JSON.stringify(
        {
          paidRequests: 0,
          success,
          ownedMockCalls: calls,
          metadataCalls,
          toolSteps: toolStep,
          errors,
          report: run.directory
        },
        null,
        2
      )
    )
    if (!success) throw new Error(`Local acceptance failed; report: ${run.directory}; fixture: ${errors.join(';')}`)
    process.stdout.write(
      `PASS quality actual ${profile} executor: ${plan.userTurns} user turns, ${calls} owned loopback calls, 0 paid requests\n`
    )
  } finally {
    if (before === undefined) delete process.env[envName]
    else process.env[envName] = before
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const profile = process.argv[2] ?? 'quick'
  if (!['quick', 'release', 'mixed', 'interactive', 'failures'].includes(profile) || process.argv.length > 3)
    throw new Error('Only owned quick/release/mixed/interactive/failures mock profiles are allowed')
  const directory = path.resolve('local/quality-reports', `acceptance-${Date.now()}`)
  mkdir(directory, { recursive: true })
    .then(() =>
      profile === 'failures'
        ? uiFailureSmoke(path.resolve(__dirname, '../..'), directory)
        : acceptanceSmoke(
            path.resolve(__dirname, '../..'),
            directory,
            profile as 'quick' | 'release' | 'mixed' | 'interactive'
          )
    )
    .catch((error) => {
      process.stderr.write(String(error) + `\n证据：${directory}\n`)
      process.exitCode = 1
    })
}
