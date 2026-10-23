import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { redact, sanitizeEvidence } from './process'
import type { CaseStatus, QualityReport } from './types'

const labels: Record<CaseStatus, string> = {
  planned: '计划中（未执行）',
  passed: '通过',
  failed: '失败',
  skipped: '跳过',
  not_run: '未执行',
  environment_blocked: '环境阻塞',
  review_required: '语义待复核',
  cancelled: '已取消'
}

export function summarize(report: QualityReport) {
  const summary: QualityReport['summary'] = {
    planned: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    not_run: 0,
    environment_blocked: 0,
    review_required: 0,
    cancelled: 0
  }
  if (new Set(report.cases.map((entry) => entry.id)).size !== report.cases.length)
    throw new Error('报告存在重复用例ID，不生成重复累计的绿色总结。')
  for (const entry of report.cases) summary[entry.status]++
  report.summary = summary
  if (summary.failed > 0) report.outcome = 'failed'
  else if (report.dryRun || report.mode === 'inventory') report.outcome = 'planned'
  else if (!report.finishedAt) report.outcome = 'incomplete'
  else if (summary.cancelled > 0) report.outcome = 'cancelled'
  else if (
    summary.not_run + summary.environment_blocked + summary.review_required + summary.planned + summary.skipped > 0 ||
    report.cases.length === 0
  )
    report.outcome = 'incomplete'
  else report.outcome = 'passed'
  return report
}

function cell(value: string) {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function renderReport(report: QualityReport) {
  const text = [
    '# Zen AI / Zen API 自动质检报告',
    '',
    `- 运行：${report.runId}`,
    `- 模式：${report.mode}${report.dryRun ? '（仅计划）' : ''}`,
    `- 结果：${report.outcome}；这里的“通过”只指本报告已执行的检查，不代表真实模型/安装包/人工验收全部完成。`,
    `- 开始：${report.startedAt}`,
    `- 结束：${report.finishedAt ?? '未结束'}`,
    report.network.paidCallsAuthorized
      ? '- 本批按批准配置开放模型调用；仅网关注入选中凭据，独立测试目录不是OS沙箱。'
      : '- 本批未授权付费调用，未继承 API/数据库凭据；独立测试目录不是操作系统安全沙箱。',
    '- 各检查组可能覆盖同一测试文件；测试项按组展示，不能相加当作唯一用例数。',
    '',
    '## 检查结果',
    '',
    '| 检查 | 项目 | 状态 | 用时 | 测试项（通过/失败/跳过/待办） |',
    '| --- | --- | --- | --- | --- |'
  ]
  for (const entry of report.cases) {
    const tests = entry.tests
      ? `${entry.tests.passed}/${entry.tests.failed}/${entry.tests.skipped}/${entry.tests.pending}`
      : '不适用/未获得'
    text.push(
      `| ${entry.id} ${cell(entry.title)} | ${entry.project} | ${labels[entry.status]}${entry.warnings?.length ? '（有警告）' : ''} | ${(entry.durationMs / 1000).toFixed(2)}s | ${tests} |`
    )
  }
  for (const entry of report.cases) if (entry.detail) text.push(`\n${entry.id}：${entry.detail}\n`)
  const warnings = report.cases.flatMap((entry) => (entry.warnings ?? []).map((warning) => `${entry.id}：${warning}`))
  if (warnings.length) text.push('', '## 非阻断警告', '', ...warnings.map((warning) => `- ${warning}`))
  if (!report.cases.length) text.push('\n本次没有执行检查；不能据此认定产品正常。')
  text.push('', '## 版本与范围', '')
  for (const [project, revision] of Object.entries(report.revisions)) {
    text.push(
      `- ${project}：HEAD ${revision.head ?? '未知'}；base ${revision.base ?? '未知'}；未提交改动 ${revision.dirty ?? '未知'}；差异摘要 ${revision.changeDigest ?? '未知'}`
    )
  }
  for (const selection of report.selection)
    text.push(
      `- ${selection.project}：${selection.reasons.join('；')} ${selection.fallbackToFull ? '（已扩大全量）' : ''}`
    )
  text.push('', '## 盘点', '')
  for (const entry of report.inventory)
    text.push(
      `- ${entry.project}：${entry.available ? `发现 ${entry.testFiles} 个测试文件、${entry.workflows.length} 个工作流；文件数不等于覆盖率` : '不可读取'}`
    )
  text.push('', '## 尚需人工或后续自动化验证', '')
  for (const manual of report.manualRequired) {
    text.push(
      `### ${manual.id} ${manual.title}`,
      '',
      `原因：${manual.reason}`,
      '',
      ...manual.steps.map((step, index) => `${index + 1}. ${step}`),
      '',
      '可复制提示词：',
      '',
      '~~~text',
      manual.prompt,
      '~~~',
      '',
      `预期：${manual.expected}`,
      ''
    )
  }
  text.push('## 限制', '', ...report.limitations.map((item) => `- ${item}`))
  if (report.livePlan)
    text.push('', '## 在线测试配置与预算计划', '', '~~~json', JSON.stringify(report.livePlan, null, 2), '~~~')
  if (report.liveResult)
    text.push(
      '',
      '## 在线实际观测（报价估算不等于结算）',
      '',
      '~~~json',
      JSON.stringify(report.liveResult, null, 2),
      '~~~'
    )
  return redact(text.join('\n')) + '\n'
}

export async function saveReport(directory: string, report: QualityReport) {
  summarize(report)
  await mkdir(directory, { recursive: true })
  // No existing run is reused. Rename per file keeps partially written JSON from looking valid.
  for (const [name, contents] of [
    ['report.json', JSON.stringify(sanitizeEvidence(report), null, 2) + '\n'],
    ['report.md', renderReport(report)]
  ]) {
    const temporary = path.join(directory, `${name}.partial`)
    await writeFile(temporary, contents, { encoding: 'utf8', flag: 'w' })
    await rename(temporary, path.join(directory, name))
  }
}

export function reportExitCode(report: QualityReport) {
  if (report.outcome === 'failed') return 1
  if (report.outcome === 'cancelled') return 130
  if (report.outcome === 'incomplete') return 2
  return 0
}
