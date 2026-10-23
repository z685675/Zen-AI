import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { prepareLivePlan } from './approval'
import { contextEvidence } from './context-evidence'
import { costMarkdown, costSummary, type TurnCost } from './cost'
import {
  assistantWorkspace,
  attachFiles,
  checkHistory,
  checkToolOutput,
  closeIsolated,
  launchIsolated,
  openEntry,
  prepareToolFixture,
  readMessages,
  seedModel,
  sendUI,
  verifyIsolatedPython
} from './electron'
import { checkOriginals, generateFiles, generateLargeFiles, hashBytes, inspectOutput, safeFile } from './files'
import { type CallEvidence, isBlockingCallFailure, startBudgetGateway } from './gateway'
import { describeInputSizing, inputSizingPolicy } from './input-sizing'
import { type JudgeSample, runJudge } from './judge'
import { fileTestContextWindow, liveConfigSchema, RequestBudget } from './live'
import { tasksForTarget } from './matrix'
import { createFileTaskPermissionGuard } from './native-write-permission'
import { MoneyBudget, validatePrice } from './pricing'
import { redact, sanitizeEvidence } from './process'
import { prepareQualityPython } from './python-runtime'
import { checkAnswer } from './scenarios'
import { inspectRevision } from './selection'
import type { QualityReport } from './types'

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}

export async function runLive(input: {
  value: unknown
  approval?: string
  root: string
  directory: string
  report: QualityReport
  signal?: AbortSignal
  checkpoint: () => Promise<void>
}) {
  const config = liveConfigSchema.parse(input.value)
  const { plan, scenarios } = await prepareLivePlan(config, input.root, await inspectRevision(input.root, 'HEAD'))
  if (!plan.executionAvailable) throw new Error(`在线预检阻塞：${plan.blockers.join('；')}`)
  if (input.approval !== plan.approvalDigest)
    throw new Error('批准摘要不匹配：模型/价格/题库/源代码/构建已改变。请重新dry-run确认。')
  if (input.signal?.aborted) throw new Error('已取消，未读取凭据或发送请求。')
  const selected = new Set(config.targets.map((target) => target.providerRef))
  if (config.judge) selected.add(config.judge.providerRef)
  // Credentials remain in this parent gateway only; no user store scanning or key in renderer/child env.
  const credentials = new Map(
    (config.providers ?? [])
      .filter((provider) => selected.has(provider.providerRef))
      .map((provider) => {
        const key = process.env[provider.credentialEnv]
        if (!key?.trim() || /\s/.test(key)) throw new Error(`缺少本次明确选择的凭据引用：${provider.credentialEnv}`)
        return [provider.providerRef, key]
      })
  )
  const execution = config.execution!
  const money = config.budget.mode === 'money' ? new MoneyBudget(config.budget.maxAmount!) : undefined
  const moneySnapshot = () => money?.snapshot() ?? { amount: null, limit: null, basis: 'unpriced-token-limits-only' }
  const tokens = new RequestBudget(config.budget)
  const controller = new AbortController()
  const abort = () => {
    money?.stop()
    tokens.stop()
    controller.abort()
  }
  input.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, config.budget.timeoutMs)
  const observations: unknown[] = []
  const allCalls: CallEvidence[] = []
  const turns: TurnCost[] = []
  const judgeSamples: JudgeSample[] = []
  // Freeze the denominator up front. Early startup/HTTP failures must not erase unrun cases.
  const jobs = config.targets.flatMap((target, index) =>
    (index % 2 === 0 ? target.entries : [...target.entries].reverse()).map((entry) => {
      const tasks = tasksForTarget(
        scenarios,
        config.profile,
        entry,
        config.allocation,
        index,
        config.targets.length
      ).map((scenario, round) => ({
        ...scenario,
        round: round + 1,
        tool: scenario.id === 'tool'
      }))
      return {
        target,
        index,
        entry,
        tasks: tasks.map((task) => {
          const id = `LIVE-${index}-${entry}-${task.id}`
          const result: QualityReport['cases'][number] = {
            id,
            project: 'ai',
            title: `${target.modelId} / ${entry} / 第${task.round}轮${task.tool ? '：真实工具/原件保护' : ''}`,
            status: 'not_run',
            durationMs: 0,
            evidence: []
          }
          const turn: TurnCost = {
            id,
            modelId: target.modelId,
            providerRef: target.providerRef,
            entry,
            round: task.round,
            attempted: false,
            completed: false
          }
          turns.push(turn)
          input.report.cases.push(result)
          return { ...task, id, result, turn }
        })
      }
    })
  )
  let python: Awaited<ReturnType<typeof prepareQualityPython>> | undefined
  let cleanupConfirmed = true
  input.report.limitations = [
    '实际点击隔离开发构建中的输入/发送入口；不是已发布安装包的升级/实机验收。',
    config.budget.mode === 'tokens'
      ? '无报价限量验收：费用未知，只限制请求数、Token预留和超时，不提供人民币金额上限。'
      : '报价/币种由操作者核实，只计算价格快照估算；没有服务端结算权限，渠道/上游账号未知。',
    '混用按关联用例组固定分配模型；不在连续记忆中随机换模型，不把未分配组合当作通过。',
    '输入包含缓存；缓存未知不按0显示。' + describeInputSizing(inputSizingPolicy(config)),
    '所有已配置模型调用经本地预算网关；未授权模型/路径拒绝。无OS沙箱，已授权工具仍应在受限账号运行。',
    '隔离实例只保留本批模型及默认辅助模型，不沿用个人命名/整理配置；不能冒充个人配置下的精确成本。',
    '固定关键事实与独立文件解析不等于开放式语义/排版已通过；真实微信/登录/Mac另需人工。'
  ]
  try {
    await input.checkpoint()
    if (
      jobs.some(
        (job) => job.entry === 'assistant' && job.tasks.some((task) => task.tool || task.kind?.startsWith('file-'))
      )
    ) {
      const started = performance.now()
      const result: QualityReport['cases'][number] = {
        id: 'LIVE-PYTHON',
        project: 'ai',
        title: '验收专用 Zen Python 免费预检',
        status: 'environment_blocked',
        durationMs: 0,
        evidence: ['python-environment.json']
      }
      input.report.cases.push(result)
      process.stdout.write(
        '[LIVE-PYTHON] 正在准备/验证验收专用 Zen Python，不调用模型；首次可能需要下载运行时和依赖。\n'
      )
      try {
        python = await prepareQualityPython(input.root, input.directory, controller.signal)
        result.status = 'passed'
        result.detail = '真实导入依赖、计算、JSON/Excel 读写及原件保护通过；仅运行时复用，会话与密钥仍隔离。'
      } catch (error) {
        result.status = controller.signal.aborted ? 'cancelled' : 'environment_blocked'
        result.detail = redact(String(error))
        for (const job of jobs)
          for (const task of job.tasks) {
            task.result.status = result.status
            task.result.detail = '验收环境预检未完成，整批未发送模型生成请求；不判定为模型能力失败。'
          }
        process.stdout.write(`[LIVE-PYTHON] ${result.status}：${result.detail}\n`)
        return
      } finally {
        result.durationMs = performance.now() - started
        await input.checkpoint()
      }
    }
    if (controller.signal.aborted) throw new Error('本批已取消，未启动模型请求。')
    input.report.network.paidCallsAuthorized = true
    for (const job of jobs) {
      if (controller.signal.aborted) throw new Error('本批取消/超时；未执行项保留，不算通过。')
      if (tokens.snapshot().stopped || money?.snapshot().stopped)
        throw new Error('本批请求/Token/金额预算已停止；未执行项保留，不算通过。')
      const { target, index, entry } = job
      const provider = config.providers!.find((item) => item.providerRef === target.providerRef)!
      const price =
        config.budget.mode === 'money'
          ? validatePrice(
              config.prices!.find(
                (item) =>
                  item.providerRef === target.providerRef &&
                  item.modelId === target.modelId &&
                  item.basis === 'key-charge'
              )
            )
          : undefined
      const directory = path.join(input.directory, `target-${index}-${entry}`)
      await mkdir(directory, { recursive: true })
      const gateway = await startBudgetGateway({
        modelId: target.modelId,
        baseURL: provider.baseURL,
        credential: credentials.get(target.providerRef)!,
        price,
        money,
        acknowledgedUnknownCost: config.budget.acknowledgedUnknownCost,
        tokens,
        maxInput: execution.maxInputTokensPerRequest,
        maxOutput: config.budget.maxOutputTokensPerRequest,
        timeoutMs: execution.requestTimeoutMs,
        vision: config.vision,
        approximateInputSizing: config.deep?.acknowledgedApproximateInputSizing,
        inputSizing: inputSizingPolicy(config),
        maxRequestsPerTurn: config.budget.maxRequestsPerTurn,
        signal: controller.signal
      })
      let application: Awaited<ReturnType<typeof launchIsolated>> | undefined
      try {
        application = await launchIsolated(
          input.root,
          directory,
          controller.signal,
          entry === 'assistant' ? python : undefined
        )
        const { page } = application
        if (entry === 'assistant' && python) {
          try {
            await verifyIsolatedPython(page, python)
          } catch (error) {
            const detail = redact(String(error))
            input.report.cases.push({
              id: `LIVE-${index}-assistant-PYTHON`,
              project: 'ai',
              title: '隔离产品 Zen Python 可用性',
              status: 'environment_blocked',
              durationMs: 0,
              evidence: ['python-environment.json'],
              detail
            })
            for (const pending of jobs)
              for (const task of pending.tasks)
                if (task.result.status === 'not_run') {
                  task.result.status = 'environment_blocked'
                  task.result.detail = '隔离产品未能使用验收 Python，停止后续模型请求；已完成请求的费用保留。'
                }
            process.stdout.write(`[LIVE-${index}-assistant-PYTHON] environment_blocked：${detail}\n`)
            return
          }
        }
        await seedModel(page, {
          url: gateway.url,
          token: gateway.token,
          modelId: target.modelId,
          maxOutput: config.budget.maxOutputTokensPerRequest,
          contextWindowTokens: fileTestContextWindow(config, target, entry)
        })
        await openEntry(page, entry)
        const files = config.modules?.includes('files')
          ? await generateFiles(path.join(application.instance, 'gold-files'))
          : undefined
        const large = config.modules?.includes('files')
          ? await generateLargeFiles(path.join(application.instance, 'large-files'))
          : undefined
        for (const task of job.tasks) {
          if (controller.signal.aborted) throw new Error('本批已停止，未发送下一问。')
          const started = performance.now()
          task.turn.attempted = true
          let permissionGuard: Awaited<ReturnType<typeof createFileTaskPermissionGuard>> | undefined
          process.stdout.write(
            `[${task.id}] ${target.modelId} / ${entry} 开始；${money ? `已估算 ${money.snapshot().amount} ${config.budget.currency}` : `已调用 ${tokens.snapshot().requests} 次，费用未核算`}\n`
          )
          try {
            await input.checkpoint()
            const fixture = task.tool ? await prepareToolFixture(page, application.instance) : undefined
            permissionGuard = fixture
              ? await createFileTaskPermissionGuard(page, application.instance, fixture)
              : undefined
            if (task.kind === 'history') observations.push({ id: task.id, history: await checkHistory(page, entry) })
            if (task.kind === 'file-read' && files && task.format)
              await attachFiles(application, [files[task.format].file], entry)
            if (task.kind === 'file-multiple' && large)
              await attachFiles(
                application,
                large.files.map((file) => file.file),
                entry
              )
            if (task.kind === 'file-corrupt' && large) await attachFiles(application, [large.corrupt], entry)
            const output =
              task.kind === 'file-create' && task.format
                ? path.join(await assistantWorkspace(page, application.instance), `quality-output.${task.format}`)
                : undefined
            gateway.beginTurn(task.id)
            const answer = await sendUI(
              page,
              fixture?.prompt ??
                (output
                  ? `请用刚才附件里的数据制作一个${task.format}文件，项目编号ZX7319，三笔金额120、230、350，合计700，负责人LIN。${task.format === 'xlsx' ? '三笔金额放在C2、C3、C4，C5用SUM(C2:C4)公式合计。' : ''}保存到${output}。请保留原文件，不要联网。`
                  : task.prompt),
              execution.turnTimeoutMs,
              controller.signal,
              {
                checkFailure: async () => {
                  gateway.assertTurnHealthy(task.id, true)
                  await permissionGuard?.checkPermission()
                },
                onWaiting: (elapsedMs, { phase }) =>
                  process.stdout.write(
                    `[${task.id}] ${phase === 'permission' ? '等待工具权限确认' : phase === 'tool' ? '工具正在处理' : '等待模型响应'}，已用时${Math.round(elapsedMs / 1000)}秒；本轮底层请求${gateway.calls.filter((call) => call.turnId === task.id).length}次\n`
                  )
              }
            )
            const verdict = checkAnswer(answer.answer, task.required)
            if (!verdict.nonempty || verdict.missing.length)
              throw new Error(`回答缺少固定答案：${verdict.missing.join(',')}`)
            if (task.forbidden?.some((value) => answer.answer.replaceAll(',', '').includes(value)))
              input.report.cases.push({
                id: `${task.id}-STALE-REVIEW`,
                project: 'ai',
                title: '旧结论出现在回答中，需判断是否已明确作废',
                status: 'review_required',
                durationMs: 0,
                evidence: []
              })
            if (fixture) {
              await checkToolOutput(fixture)
              observations.push({
                id: task.id,
                nativeWriteApprovals: permissionGuard!.approved,
                deniedPermissions: permissionGuard!.denied
              })
            }
            if (files) await checkOriginals(application.instance, files)
            if (large)
              for (const file of large.files)
                if (hashBytes(await safeFile(application.instance, file.file)) !== file.sha256)
                  throw new Error('大附件原件被改动。')
            if (
              task.kind === 'file-corrupt' &&
              !/损坏|无法|不能|失败|corrupt|cannot|unable|invalid/i.test(answer.answer)
            )
              throw new Error('受损文件未得到明确失败说明，可能伪造读取结果。')
            if (output && task.format)
              observations.push({ id: task.id, output: await inspectOutput(application.instance, output, task.format) })
            const deadline = performance.now() + execution.requestTimeoutMs
            let quietAt = performance.now()
            let observed = gateway.calls.length
            while (performance.now() < deadline) {
              if (controller.signal.aborted) throw new Error('本批已停止')
              if (!gateway.isIdle() || observed !== gateway.calls.length) {
                quietAt = performance.now()
                observed = gateway.calls.length
              }
              if (gateway.isIdle() && performance.now() - quietAt >= 1200) break
              await pause(100, controller.signal)
            }
            if (!gateway.isIdle()) throw new Error('辅助调用未结束，不能安全开始下一轮。')
            gateway.assertTurnHealthy(task.id)
            if (
              !gateway.calls.some(
                (call) => call.turnId === task.id && call.purpose !== 'topic-naming' && call.completed && !call.error
              )
            )
              throw new Error('没有本轮主任务成功调用证据，不能仅凭自动命名当作通过。')
            const recovered = gateway.calls.filter(
              (call) => call.turnId === task.id && isBlockingCallFailure(call)
            ).length
            if (recovered) task.result.detail = `原生重试后恢复；${recovered}次失败尝试均保留在调用与费用统计中。`
            const warnings = [
              ...gateway.turnWarnings(task.id),
              ...(permissionGuard?.denied.map(
                (decision) => `未授权的 ${decision.toolName} 已通过界面拒绝；模型换用其他方式完成，文件及原件校验通过。`
              ) ?? [])
            ]
            if (warnings.length) {
              task.result.warnings = warnings
              process.stdout.write(`[${task.id}] 主回答通过；${warnings.join('；')}\n`)
            }
            await page.screenshot({ path: path.join(directory, `${task.id}.png`) })
            task.result.evidence.push(path.relative(input.directory, path.join(directory, `${task.id}.png`)))
            task.result.status = 'passed'
            task.turn.completed = true
            if (task.id.endsWith('memory-recall'))
              judgeSamples.push({
                id: task.id,
                question: task.prompt,
                answer: answer.answer.slice(0, 16000),
                facts: [
                  {
                    id: 'latest',
                    expected:
                      '项目ZX7319，负责人ZHOU，总预算5500元，可用3500元，口令MIDDLE4621，2026-12-18交付；原文件不能覆盖。'
                  }
                ]
              })
            observations.push({
              id: task.id,
              modelId: target.modelId,
              providerRef: target.providerRef,
              entry,
              round: task.round,
              ...answer
            })
          } catch (error) {
            task.result.status = controller.signal.aborted ? 'cancelled' : 'failed'
            task.result.detail = redact(error instanceof Error ? error.message : '任务失败')
            process.stdout.write(`[${task.id}] ${task.result.status}：${task.result.detail}\n`)
            const partial = await readMessages(page).catch(() => [])
            observations.push({
              id: task.id,
              modelId: target.modelId,
              providerRef: target.providerRef,
              entry,
              round: task.round,
              failed: true,
              error: task.result.detail,
              ...(permissionGuard
                ? { nativeWriteApprovals: permissionGuard.approved, deniedPermissions: permissionGuard.denied }
                : {}),
              // Only this isolated synthetic conversation; never ordinary userData/history.
              partial: partial
                .filter((message) => message.role === 'assistant')
                .slice(-2)
                .map((message) => ({
                  id: message.id,
                  status: message.status,
                  text: message.text.slice(0, 64000)
                }))
            })
            await page.screenshot({ path: path.join(directory, 'failed.png') }).catch(() => {})
            throw error
          } finally {
            task.result.durationMs = performance.now() - started
            await input.checkpoint()
          }
          if (execution.pauseMs) await pause(execution.pauseMs, controller.signal)
        }
        if (config.profile === 'deep' && config.deep) {
          const evidence = await contextEvidence(page, application.instance, entry)
          const observed = Math.max(
            0,
            ...gateway.calls.filter((call) => call.usageKnown).map((call) => call.usage!.input)
          )
          const passed =
            observed >= config.deep.minimumObservedInputTokens &&
            (!config.deep.requireCompaction || evidence.compactionObserved)
          observations.push({ entry, modelId: target.modelId, observedInputTokens: observed, context: evidence })
          input.report.cases.push({
            id: `LIVE-${index}-${entry}-CAPACITY`,
            project: 'ai',
            title: '实际容量与原生整理证据',
            status: passed ? 'passed' : 'environment_blocked',
            durationMs: 0,
            evidence: [],
            detail: passed
              ? `实际最大输入${observed}Token；压缩证据${evidence.compactionObserved}`
              : `未达到已批准容量/压缩门槛。实际最大输入${observed}Token；压缩证据${evidence.compactionObserved}；字符数不当作Token数。`
          })
        }
      } catch (error) {
        if ((error as { isolationCleanupUnconfirmed?: boolean }).isolationCleanupUnconfirmed) cleanupConfirmed = false
        if (application) {
          const ui = {
            url: application.page.url(),
            body: await application.page
              .locator('body')
              .innerText({ timeout: 3000 })
              .catch(() => 'unavailable')
          }
          await writeFile(
            path.join(directory, 'ui-state.json'),
            JSON.stringify(sanitizeEvidence({ ...ui, body: ui.body.slice(0, 64000) }), null, 2)
          )
        }
        if (
          !application ||
          controller.signal.aborted ||
          tokens.snapshot().stopped ||
          money?.snapshot().stopped ||
          !job.tasks.some((task) => task.result.status === 'failed')
        )
          throw error
        for (const task of job.tasks)
          if (task.result.status === 'not_run')
            task.result.detail = '本会话前序轮次失败；保留未执行，不跳过后继续对话。'
        process.stdout.write(`[LIVE-${index}-${entry}] 本会话失败，保存记录并继续其他模型/入口。\n`)
      } finally {
        // Stop the product (including native retries) before taking its gateway away.
        if (application)
          try {
            await closeIsolated(application.application)
          } catch (error) {
            cleanupConfirmed = false
            input.report.cases.push({
              id: `LIVE-${index}-${entry}-APP-CLEANUP`,
              project: 'ai',
              title: '隔离应用退出',
              status: 'failed',
              durationMs: 0,
              evidence: [],
              detail: redact(String(error))
            })
            abort()
          }
        try {
          await gateway.close()
        } catch (error) {
          input.report.cases.push({
            id: `LIVE-${index}-${entry}-GATEWAY-CLEANUP`,
            project: 'ai',
            title: '网关退出/在途费用确认',
            status: 'failed',
            durationMs: 0,
            evidence: [],
            detail: redact(String(error))
          })
          abort()
        } finally {
          allCalls.push(...gateway.calls)
          await writeFile(
            path.join(directory, 'calls.json'),
            JSON.stringify(
              sanitizeEvidence({ currency: config.budget.currency, calls: gateway.calls, rejected: gateway.rejected }),
              null,
              2
            )
          )
        }
      }
    }
    if (config.judge && judgeSamples.length) {
      const judge = config.judge
      const provider = config.providers!.find((value) => value.providerRef === judge.providerRef)!
      const price = validatePrice(
        config.prices!.find(
          (value) =>
            value.providerRef === judge.providerRef && value.modelId === judge.modelId && value.basis === 'key-charge'
        )
      )
      const result = await runJudge({
        modelId: judge.modelId,
        baseURL: provider.baseURL,
        credential: credentials.get(judge.providerRef)!,
        price,
        money: money!,
        tokens,
        maxRequests: judge.maxRequests,
        maxAmount: judge.maxAmount,
        maxInput: judge.maxInputTokensPerRequest,
        signal: controller.signal,
        samples: judgeSamples
      })
      await writeFile(
        path.join(input.directory, 'judge-results.json'),
        JSON.stringify(sanitizeEvidence(result), null, 2)
      )
      input.report.cases.push({
        id: 'JUDGE',
        project: 'ai',
        title: '可选裁判：校准与记忆关键事实',
        status: result.verdict === 'passed' ? 'passed' : 'review_required',
        durationMs: 0,
        evidence: ['judge-results.json'],
        detail: result.detail ?? result.scope
      })
    }
  } finally {
    clearTimeout(timeout)
    credentials.clear()
    input.signal?.removeEventListener('abort', abort)
    if (python) {
      if (cleanupConfirmed) {
        try {
          await python.release()
        } catch (error) {
          input.report.cases.push({
            id: 'LIVE-PYTHON-LEASE',
            project: 'ai',
            title: '验收 Python 占用释放',
            status: 'environment_blocked',
            durationMs: 0,
            evidence: [],
            detail: redact(String(error))
          })
        }
      } else
        input.report.cases.push({
          id: 'LIVE-PYTHON-LEASE',
          project: 'ai',
          title: '验收 Python 占用释放',
          status: 'environment_blocked',
          durationMs: 0,
          evidence: [],
          detail: '隔离应用退出未确认，保留专用环境占用文件，避免下一批修复仍在使用的运行时。'
        })
    }
    await writeFile(
      path.join(input.directory, 'live-observations.json'),
      JSON.stringify(sanitizeEvidence(observations), null, 2)
    )
    await writeFile(
      path.join(input.directory, 'budget.json'),
      JSON.stringify({ money: moneySnapshot(), tokens: tokens.snapshot() }, null, 2)
    )
    const summary = costSummary(turns, allCalls, config.budget.mode === 'money')
    await writeFile(path.join(input.directory, 'cost-summary.json'), JSON.stringify(summary, null, 2))
    await writeFile(
      path.join(input.directory, 'cost-summary.md'),
      costMarkdown(summary, config.budget.currency ?? '未知')
    )
    input.report.liveResult = {
      money: moneySnapshot(),
      tokens: tokens.snapshot(),
      completedUserTurns: turns.filter((turn) => turn.completed).length,
      expectedUserTurns: plan.userTurns,
      usageBasis: 'gateway-observed; auxiliary attribution by isolated active turn, not guaranteed server task grouping'
    }
  }
}
