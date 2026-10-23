import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as z from 'zod'

import { prepareLivePlan } from './approval'
import { saveEvidence } from './evidence'
import { checkOriginals, generateFiles, inspectOutput } from './files'
import { loadManifest } from './manifest'
import { auditPackage, packageSnapshot } from './package-audit'
import { planDigest } from './pricing'
import { redact } from './process'
import { reportExitCode, saveReport } from './report'
import { runQuality } from './run'
import { inspectRevision } from './selection'
import type { QualityReport } from './types'
import { uiSmoke } from './ui-smoke'

export const acceptanceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  code: z.enum(['offline', 'release']),
  codeReport: z.string().optional(),
  projects: z
    .array(z.enum(['ai', 'api']))
    .min(1)
    .max(2),
  ui: z.boolean(),
  files: z.boolean(),
  apiRoot: z.string().optional(),
  packages: z
    .array(
      z.strictObject({
        resources: z.string().min(1),
        platform: z.enum(['windows', 'mac', 'linux']),
        arch: z.enum(['x64', 'arm64']),
        expectedVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-.\w]*)$/),
        bundle: z.string().optional(),
        requireSignature: z.boolean().optional()
      })
    )
    .max(6),
  requiredPlatforms: z
    .array(z.enum(['windows/x64', 'windows/arm64', 'mac/x64', 'mac/arm64', 'linux/x64', 'linux/arm64']))
    .max(6),
  liveConfig: z.string().optional(),
  requireRealModels: z.boolean()
})
export type AcceptanceConfig = z.infer<typeof acceptanceSchema>

export async function previewAcceptance(value: unknown, root: string) {
  const config = acceptanceSchema.parse(value)
  if (!config.projects.includes('ai') && (config.ui || config.packages.length || config.liveConfig))
    throw new Error('UI/客户端安装包/真实模型验收必须选择ai项目。')
  if (
    new Set(config.projects).size !== config.projects.length ||
    new Set(config.requiredPlatforms).size !== config.requiredPlatforms.length
  )
    throw new Error('验收项目/平台重复。')
  const identities = config.packages.map((item) => `${item.platform}/${item.arch}`)
  if (new Set(identities).size !== identities.length) throw new Error('同一平台安装包重复。')
  const revisions: QualityReport['revisions'] = {}
  for (const project of config.projects)
    revisions[project] = await inspectRevision(
      project === 'ai' ? root : (config.apiRoot ?? path.resolve(root, '../Zen-API')),
      'HEAD'
    )
  const artifacts: Array<Awaited<ReturnType<typeof packageSnapshot>>> = []
  for (const target of config.packages) artifacts.push(await packageSnapshot(root, target))
  let codeReportDigest: string | null = null
  if (config.codeReport) {
    const prior = JSON.parse(await readFile(path.resolve(root, config.codeReport), 'utf8')) as QualityReport
    if (
      prior.schemaVersion !== 1 ||
      prior.mode !== config.code ||
      prior.outcome !== 'passed' ||
      prior.dryRun ||
      !prior.finishedAt ||
      !prior.cases.length ||
      prior.cases.some((item) => item.status !== 'passed')
    )
      throw new Error('复用的代码报告未完整通过或检查档位不符。')
    for (const project of config.projects) {
      const recorded = prior.finalRevisions?.[project] ?? prior.revisions[project]
      if (
        !recorded?.head ||
        recorded.head !== revisions[project]?.head ||
        recorded.changeDigest !== revisions[project]?.changeDigest
      )
        throw new Error('旧代码报告与当前代码不一致，不能免测。')
    }
    codeReportDigest = planDigest(prior)
  }
  let live: Awaited<ReturnType<typeof prepareLivePlan>>['plan'] | null = null
  if (config.liveConfig) {
    if (!config.projects.includes('ai')) throw new Error('真实模型UI验收必须包含ai项目。')
    live = (
      await prepareLivePlan(
        JSON.parse(await readFile(path.resolve(root, config.liveConfig), 'utf8')),
        root,
        revisions.ai!
      )
    ).plan
  }
  const phases = [
    { id: 'CODE', title: `${config.projects.join('+')} ${config.code}代码门槛`, scope: 'automatic' },
    ...(config.files ? [{ id: 'GOLD-FILES', title: '生成七类金标准文件并独立校验', scope: 'automatic' }] : []),
    ...(config.ui ? [{ id: 'UI', title: '真实隔离双入口与工具闭环（本地模拟）', scope: 'automatic' }] : []),
    ...config.packages.map((item) => ({
      id: `PACKAGE-${item.platform}-${item.arch}`,
      title: `安装包资源/架构/签名 ${item.platform}/${item.arch}`,
      scope: 'automatic'
    })),
    ...config.requiredPlatforms
      .filter((item) => !identities.includes(item))
      .map((item) => ({
        id: `MISSING-${item.replace('/', '-')}`,
        title: `${item}安装包尚未提供`,
        scope: 'missing-artifact'
      })),
    ...(config.liveConfig || config.requireRealModels
      ? [
          {
            id: 'LIVE',
            title: '真实模型明确矩阵与预算',
            scope: config.liveConfig ? 'paid-approved-only' : 'missing-configuration'
          }
        ]
      : [])
  ]
  const snapshot = { config, revisions, artifacts, live, codeReportDigest }
  return {
    phases,
    snapshot,
    approvalDigest: planDigest(snapshot),
    paidCallsInPreview: 0,
    manualStillRequired: [
      '实际安装/覆盖升级与既有数据检查',
      'Mac实机、登录验证码、真实微信收发（按改动选择）',
      'Office版式与专业语义抽检'
    ]
  }
}

export async function runAcceptance(
  value: unknown,
  root: string,
  options: { dryRun: boolean; approval?: string; signal?: AbortSignal }
) {
  const config = acceptanceSchema.parse(value)
  const plan = await previewAcceptance(config, root)
  if (!options.dryRun && options.approval !== plan.approvalDigest)
    throw new Error('请先预览整批验收并用--approve批准完整摘要；源码/包/真实模型配置变化须重新确认。')
  const runId = `acceptance-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const directory = path.join(root, 'local/quality-reports', runId)
  await mkdir(directory, { recursive: true })
  const manifest = await loadManifest(path.join(root, 'tests/quality/manifest.json'))
  const report: QualityReport = {
    schemaVersion: 1,
    runId,
    mode: 'release',
    dryRun: options.dryRun,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      packaged: config.packages.length > 0
    },
    network: { paidCallsAuthorized: false, credentialsInherited: false, osSandbox: false },
    revisions: plan.snapshot.revisions,
    inventory: [],
    selection: [],
    cases: plan.phases.map((phase) => ({
      id: phase.id,
      project: 'ai',
      title: phase.title,
      status: options.dryRun ? 'planned' : 'not_run',
      durationMs: 0,
      evidence: []
    })),
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
    manualRequired: manifest.manual.filter((item) => item.id !== 'MAN-LIVE'),
    outcome: 'incomplete',
    limitations: [
      '自动门槛与人工签收分开；自动通过不等于已正式批准发布。',
      '安装包检查不等于在用户系统完成安装/升级；Mac设备和真实账号交互需人工。',
      '默认不使用付费凭据；真实批次须绑定完整配置/报价/预算。',
      '本地模拟的Token/费用均为合成数据，不用于真实缓存或成本结论。'
    ],
    livePlan: plan
  }
  const children: Array<{ phase: string; report: string; outcome: string }> = []
  let blocked = false
  await saveReport(directory, report)
  try {
    if (!options.dryRun)
      for (const result of report.cases) {
        if (options.signal?.aborted) {
          result.status = 'cancelled'
          continue
        }
        if (blocked) {
          result.detail = '前置自动门槛未通过，未继续执行，也未发送后续付费请求。'
          continue
        }
        const started = performance.now()
        try {
          if (result.id === 'CODE') {
            const child = config.codeReport
              ? {
                  directory: path.dirname(path.resolve(root, config.codeReport)),
                  report: JSON.parse(await readFile(path.resolve(root, config.codeReport), 'utf8')) as QualityReport
                }
              : await runQuality(
                  { mode: config.code, projects: config.projects, dryRun: false, apiRoot: config.apiRoot },
                  root,
                  options.signal
                )
            if (config.codeReport && planDigest(child.report) !== plan.snapshot.codeReportDigest)
              throw new Error('批准后旧代码报告被替换。')
            children.push({
              phase: result.id,
              report: path.relative(directory, path.join(child.directory, 'report.json')),
              outcome: child.report.outcome
            })
            result.status =
              child.report.outcome === 'passed'
                ? 'passed'
                : child.report.outcome === 'failed'
                  ? 'failed'
                  : 'environment_blocked'
            if (config.codeReport) result.detail = '复用同一源码摘要、同档位且通过的代码报告，没有重复全量测试。'
            if (result.status !== 'passed') blocked = true
          } else if (result.id === 'GOLD-FILES') {
            const files = await generateFiles(path.join(directory, 'gold-files'))
            const observations: Array<Awaited<ReturnType<typeof inspectOutput>>> = []
            for (const format of ['json', 'docx', 'xlsx', 'pptx', 'pdf'] as const)
              observations.push(await inspectOutput(directory, files[format].file, format))
            await checkOriginals(directory, files)
            await writeFile(path.join(directory, 'file-validation.json'), JSON.stringify(observations, null, 2))
            result.evidence.push('file-validation.json')
            result.status = 'passed'
          } else if (result.id === 'UI') {
            await uiSmoke(root, directory, options.signal)
            result.status = 'passed'
          } else if (result.id.startsWith('PACKAGE-')) {
            const target = config.packages.find((item) => result.id === `PACKAGE-${item.platform}-${item.arch}`)!
            const approved = plan.snapshot.artifacts[config.packages.indexOf(target)]
            if (planDigest(await packageSnapshot(root, target)) !== planDigest(approved))
              throw new Error('批准后安装包或内核被替换，未运行新文件；请重新预览。')
            const evidence = await auditPackage(root, target, options.signal, approved)
            const file = `${result.id}.json`
            await writeFile(path.join(directory, file), JSON.stringify(evidence, null, 2))
            result.evidence.push(file)
            result.status = 'passed'
          } else if (result.id === 'LIVE' && config.liveConfig && plan.snapshot.live?.executionAvailable) {
            const child = await runQuality(
              {
                mode: 'live',
                projects: ['ai'],
                dryRun: false,
                liveConfig: path.resolve(root, config.liveConfig),
                approval: plan.snapshot.live.approvalDigest
              },
              root,
              options.signal
            )
            children.push({
              phase: result.id,
              report: path.relative(directory, path.join(child.directory, 'report.json')),
              outcome: child.report.outcome
            })
            report.network.paidCallsAuthorized = child.report.network.paidCallsAuthorized
            result.status =
              child.report.outcome === 'passed'
                ? 'passed'
                : child.report.outcome === 'failed'
                  ? 'failed'
                  : 'environment_blocked'
          } else {
            result.status = 'environment_blocked'
            result.detail = '缺少本平台安装包或已批准的真实模型配置；不缩小计划分母。'
          }
        } catch (error) {
          result.status = options.signal?.aborted ? 'cancelled' : 'failed'
          result.detail = redact(String(error))
          blocked = true
        } finally {
          if (result.status !== 'passed') blocked = true
          result.durationMs = performance.now() - started
          await saveReport(directory, report)
        }
      }
  } finally {
    for (const project of config.projects) {
      const after = await inspectRevision(
        project === 'ai' ? root : (config.apiRoot ?? path.resolve(root, '../Zen-API')),
        'HEAD'
      )
      if (
        !options.dryRun &&
        (after.head !== report.revisions[project]?.head ||
          after.changeDigest !== report.revisions[project]?.changeDigest)
      )
        report.cases.push({
          id: `SOURCE-${project}`,
          title: '验收期间代码改变',
          project,
          status: 'environment_blocked',
          durationMs: 0,
          evidence: []
        })
    }
    report.finishedAt = new Date().toISOString()
    await writeFile(path.join(directory, 'child-reports.json'), JSON.stringify(children, null, 2))
    await saveReport(directory, report)
    await saveEvidence(directory, report)
    await writeFile(
      path.join(directory, 'manual-results.template.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          runId,
          sourceDigest: planDigest(report.revisions),
          tester: '请填测试者',
          results: report.manualRequired.map((item) => ({
            id: item.id,
            status: 'not_run',
            system: '请填系统与安装包版本',
            evidence: '请填截图/诊断编号/实际观察',
            note: ''
          }))
        },
        null,
        2
      )
    )
    await writeFile(
      path.join(directory, 'release-gate.md'),
      `# 发版门槛\n\n自动结果：${report.outcome}\n\n${report.outcome === 'passed' ? '自动范围已通过，接下来处理 manual-checks.md；人工未签收，不能称为全平台已验收。' : '仍有失败/阻塞/未执行项，不建议据此发版。'}\n\n子报告：\n${children.map((child) => `- ${child.phase}：${child.report}（${child.outcome}）`).join('\n')}\n`
    )
  }
  process.stdout.write(`整批报告：${path.join(directory, 'report.md')}\n批准摘要：${plan.approvalDigest}\n`)
  return { directory, report, exitCode: reportExitCode(report) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const args = process.argv.slice(2)
  const file = args.shift()
  const dryRun = args.includes('--dry-run')
  const approval = args.includes('--approve') ? args[args.indexOf('--approve') + 1] : undefined
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  Promise.resolve()
    .then(async () => {
      if (
        !file ||
        args.some((value, index) => value !== '--dry-run' && value !== '--approve' && args[index - 1] !== '--approve')
      )
        throw new Error('用法：pnpm quality:acceptance 配置.json --dry-run 或 --approve 完整摘要')
      return runAcceptance(JSON.parse(await readFile(path.resolve(file), 'utf8')), path.resolve(__dirname, '../..'), {
        dryRun,
        approval,
        signal: controller.signal
      })
    })
    .then(({ exitCode }) => {
      process.exitCode = exitCode
    })
    .catch((error) => {
      process.stderr.write(redact(String(error)) + '\n')
      process.exitCode = 1
    })
    .finally(() => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    })
}
