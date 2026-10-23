import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { prepareLivePlan } from './approval'
import { buildCommand } from './commands'
import { saveEvidence } from './evidence'
import { runLive } from './live-run'
import { loadManifest } from './manifest'
import { execute, redact, sanitizeEvidence } from './process'
import { reportExitCode, saveReport } from './report'
import { parseGo, parseNativeSmoke, parseVitest } from './results'
import { inspectInventory, inspectRevision, selectChecks } from './selection'
import type { Check, CheckResult, Mode, Project, QualityReport } from './types'

export interface Options {
  mode: Mode
  projects: Project[]
  dryRun: boolean
  base?: string
  apiBase?: string
  apiRoot?: string
  bunPath?: string
  liveConfig?: string
  approval?: string
  liveValue?: unknown
  reportDirectory?: string
}

export function parseArgs(args: string[]): Options {
  const mode = args.shift()
  if (!['inventory', 'changed', 'offline', 'release', 'live'].includes(mode ?? ''))
    throw new Error(
      '用法：pnpm quality:<inventory|changed|offline|release|live> [--project ai|api|all] [--base SHA] [--api-base SHA] [--dry-run]'
    )
  const options: Options = { mode: mode as Mode, projects: ['ai', 'api'], dryRun: false }
  const used = new Set<string>()
  while (args.length) {
    const flag = args.shift()!
    if (used.has(flag)) throw new Error(`重复参数：${flag}`)
    used.add(flag)
    if (flag === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (!['--project', '--base', '--api-base', '--api-root', '--bun', '--config', '--approve'].includes(flag))
      throw new Error(`未知参数：${flag}`)
    const value = args.shift()
    if (!value || value.startsWith('--')) throw new Error(`缺少参数值：${flag}`)
    if (flag === '--project') {
      if (!['ai', 'api', 'all'].includes(value)) throw new Error('project 必须是 ai/api/all')
      options.projects = value === 'all' ? ['ai', 'api'] : [value as Project]
    } else if (flag === '--base') options.base = value
    else if (flag === '--api-base') options.apiBase = value
    else if (flag === '--api-root') options.apiRoot = path.resolve(value)
    else if (flag === '--bun') options.bunPath = path.resolve(value)
    else if (flag === '--approve') options.approval = value
    else options.liveConfig = path.resolve(value)
  }
  if (options.mode !== 'live' && options.liveConfig) throw new Error('--config 仅用于 live，其他模式不读取在线配置。')
  if (options.approval && (options.mode !== 'live' || !/^[a-f0-9]{64}$/.test(options.approval)))
    throw new Error('--approve仅用于live且必须是完整计划摘要。')
  return options
}

export async function runCheck(
  check: Check,
  root: string,
  directory: string,
  signal?: AbortSignal,
  bunPath?: string
): Promise<CheckResult> {
  const result: CheckResult = {
    id: check.id,
    project: check.project,
    title: check.title,
    status: 'failed',
    durationMs: 0,
    evidence: []
  }
  const raw = path.join(directory, `${check.id}.tests.json`)
  const log = path.join(directory, `${check.id}.log`)
  try {
    await access(root)
    const command = await buildCommand(check, root, raw, bunPath)
    process.stdout.write(`[${check.id}] ${check.title}\n`)
    const child = await execute(command, { timeoutMs: check.timeoutMs, signal })
    Object.assign(result, {
      exitCode: child.exitCode,
      signal: child.signal,
      timedOut: child.timedOut,
      durationMs: child.durationMs,
      outputTruncated: child.outputTruncated
    })
    await writeFile(log, redact(child.stdout + '\n' + child.stderr), 'utf8')
    result.evidence.push(path.basename(log))
    const processPassed =
      child.exitCode === 0 &&
      !child.signal &&
      !child.timedOut &&
      !child.cancelled &&
      !child.error &&
      !child.terminationUnconfirmed
    result.status = processPassed ? 'passed' : 'failed'
    if (child.cancelled) result.status = 'cancelled'
    if (child.error) {
      result.status = 'environment_blocked'
      result.detail = child.error
    }
    if (child.timedOut) result.detail = '检查超时；已尝试终止本次子进程树。'
    if (child.terminationUnconfirmed) {
      result.status = 'failed'
      result.detail = '无法确认子进程树已终止，必须人工检查。'
    }
    if (check.executor === 'vitest') {
      const bytes = (await stat(raw)).size
      if (bytes > 32 * 1024 * 1024) {
        await writeFile(raw, JSON.stringify({ invalidResult: true, originalBytes: bytes, reason: 'oversized' }), 'utf8')
        result.evidence.push(path.basename(raw))
        throw new Error('Vitest 证据文件过大，拒绝不完整汇总。')
      }
      const text = await readFile(raw, 'utf8')
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        // A malformed runner result must still not leave unsanitized evidence behind.
        await writeFile(raw, JSON.stringify({ invalidResult: true, text: redact(text) }, null, 2), 'utf8')
        throw new Error('Vitest 证据不是有效JSON。')
      }
      // Sanitize before validating so even a schema failure keeps safe, valid JSON evidence.
      await writeFile(raw, JSON.stringify(sanitizeEvidence(value), null, 2), 'utf8')
      result.evidence.push(path.basename(raw))
      const parsed = parseVitest(text)
      result.tests = parsed.tests
      if (!parsed.successful && result.status === 'passed') result.status = 'failed'
    } else if (check.executor === 'go-test') {
      if (child.outputTruncated) throw new Error('Go JSON 输出已截断，不能当作完整通过。')
      const parsed = parseGo(child.stdout)
      result.tests = parsed.tests
      if (!parsed.successful && result.status === 'passed') result.status = 'failed'
    } else if (check.target[0]?.startsWith('smoke:opencode')) {
      if (child.outputTruncated) throw new Error('原生 smoke 输出截断，缺少完整证据。')
      const parsed = parseNativeSmoke(child.stdout, check.target[0] === 'smoke:opencode:attachments')
      result.tests = parsed.tests
      if (!parsed.successful && result.status === 'passed') result.status = 'failed'
    }
    if (!processPassed && !result.detail)
      result.detail = `子进程未正常完成，exit=${child.exitCode} signal=${child.signal ?? '-'}。即使断言通过也不算检查通过。`
  } catch (error) {
    if (result.status !== 'cancelled' && result.status !== 'environment_blocked') result.status = 'failed'
    result.detail = [result.detail, redact(error instanceof Error ? error.message : '检查失败。')]
      .filter(Boolean)
      .join('；')
  }
  process.stdout.write(`[${check.id}] ${result.status}\n`)
  return result
}

export async function runQuality(options: Options, root = path.resolve(__dirname, '../..'), signal?: AbortSignal) {
  const runId = `quality-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const directory = options.reportDirectory ?? path.join(root, 'local/quality-reports', runId)
  await mkdir(directory, { recursive: true })
  process.stdout.write(`本次报告目录：${directory}\n`)
  const roots = { ai: root, api: options.apiRoot ?? path.resolve(root, '../Zen-API') }
  const report: QualityReport = {
    schemaVersion: 1,
    runId,
    mode: options.mode,
    dryRun: options.dryRun,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    environment: { platform: process.platform, arch: process.arch, node: process.version, packaged: false },
    network: { paidCallsAuthorized: false, credentialsInherited: false, osSandbox: false },
    revisions: {},
    inventory: [],
    selection: [],
    cases: [],
    summary: {
      planned: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      not_run: 0,
      environment_blocked: 0,
      review_required: 0,
      cancelled: 0
    },
    manualRequired: [],
    outcome: 'incomplete',
    limitations: [
      '本批为开发目录检查，不是安装包或界面端到端验收。',
      '未运行真实模型、真实微信、真实登录；未验证 Mac 实机。',
      '没有操作系统网络沙箱；未向测试注入真实 API/数据库凭据。',
      '报告中的检查组通过不代表组内每条业务需求都有独立自动化断言；测试跳过与待办另计。'
    ]
  }
  await saveReport(directory, report)
  try {
    const manifest = await loadManifest(path.join(root, 'tests/quality/manifest.json'))
    for (const project of options.projects) {
      report.inventory.push(await inspectInventory(roots[project], project))
      const revision = await inspectRevision(
        roots[project],
        options.mode === 'live' ? 'HEAD' : project === 'ai' ? options.base : options.apiBase
      )
      report.revisions[project] = revision
      report.selection.push(selectChecks(manifest, project, options.mode, revision))
    }
    const tags = new Set(report.selection.flatMap((selection) => selection.tags))
    report.manualRequired = manifest.manual.filter(
      (manual) => manual.tags.includes('always') || tags.has('full') || manual.tags.some((tag) => tags.has(tag))
    )
    if (options.mode === 'live') {
      report.manualRequired = manifest.manual.filter((manual) => manual.id === 'MAN-LIVE')
      if (!options.liveConfig && !options.liveValue)
        throw new Error('live 必须提供 --config；不自动读取现有 Provider 或 Key。')
      const value = options.liveValue ?? JSON.parse(await readFile(options.liveConfig!, 'utf8'))
      const { plan } = await prepareLivePlan(value, root, report.revisions.ai ?? (await inspectRevision(root, 'HEAD')))
      report.livePlan = plan
      if (!options.dryRun && plan.executionAvailable && options.approval) {
        await runLive({
          value,
          approval: options.approval,
          root,
          directory,
          report,
          signal,
          checkpoint: () => saveReport(directory, report)
        })
      } else
        report.cases.push({
          id: 'LIVE-ADAPTER',
          project: 'ai',
          title: '真实模型执行器',
          status: options.dryRun ? 'planned' : 'environment_blocked',
          durationMs: 0,
          evidence: [],
          detail: [...plan.blockers, '未执行付费调用；执行需要--approve批准此配置摘要和明确凭据引用。'].join('；')
        })
    } else {
      const selected = new Set(report.selection.flatMap((selection) => selection.checkIds))
      const checks = manifest.checks.filter((check) => selected.has(check.id))
      report.cases = checks.map((check) => ({
        id: check.id,
        project: check.project,
        title: check.title,
        status: options.dryRun ? 'planned' : 'not_run',
        durationMs: 0,
        evidence: []
      }))
      await saveReport(directory, report)
      if (!options.dryRun) {
        for (const [index, check] of checks.entries()) {
          if (signal?.aborted) {
            report.cases[index].status = 'cancelled'
          } else if (!report.inventory.find((item) => item.project === check.project)?.available) {
            report.cases[index].status = 'environment_blocked'
            report.cases[index].detail = '项目不可读取，不跳过后声称联合通过。'
          } else report.cases[index] = await runCheck(check, roots[check.project], directory, signal, options.bunPath)
          await saveReport(directory, report)
        }
      }
    }
  } catch (error) {
    report.cases.push({
      id: 'QUALITY-RUNNER',
      project: 'ai',
      title: '质检编排完整性',
      status: signal?.aborted ? 'cancelled' : 'failed',
      durationMs: 0,
      evidence: [],
      detail: redact(error instanceof Error ? error.message : '编排失败。')
    })
  } finally {
    report.finalRevisions = {}
    for (const project of options.projects) {
      const before = report.revisions[project]
      if (!before) continue
      const after = await inspectRevision(
        roots[project],
        options.mode === 'live' ? 'HEAD' : project === 'ai' ? options.base : options.apiBase
      )
      report.finalRevisions[project] = after
      if (
        !options.dryRun &&
        options.mode !== 'inventory' &&
        (before.head !== after.head || before.changeDigest !== after.changeDigest)
      ) {
        report.cases.push({
          id: `QUALITY-REVISION-${project.toUpperCase()}`,
          project,
          title: '测试期间源代码一致性',
          status: 'environment_blocked',
          durationMs: 0,
          evidence: [],
          detail: '运行期间源代码发生改变；不能把不同代码快照的结果当作同一版本验收。请在代码稳定后重跑。'
        })
      }
    }
    report.finishedAt = new Date().toISOString()
    await saveReport(directory, report)
    await saveEvidence(directory, report)
  }
  process.stdout.write(`报告：${path.join(directory, 'report.md')}\n结果：${report.outcome}\n`)
  return { directory, report, exitCode: reportExitCode(report) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  Promise.resolve()
    .then(() => runQuality(parseArgs(process.argv.slice(2)), undefined, controller.signal))
    .then(({ exitCode }) => {
      process.exitCode = exitCode
    })
    .catch((error) => {
      process.stderr.write(redact(error instanceof Error ? error.message : String(error)) + '\n')
      process.exitCode = 1
    })
    .finally(() => {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    })
}
