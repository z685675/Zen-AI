import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

import AdmZip from 'adm-zip'

import { redact, sanitizeEvidence } from './process'
import type { QualityReport } from './types'

export function manualDocument(report: QualityReport) {
  return [
    '# 本次仍需人工验证',
    '',
    `运行：${report.runId}；代码：${report.revisions.ai?.head ?? '未知'}`,
    '',
    '自动检查不覆盖真实登录/微信、Mac实机与文档审美。这里只列当前报告选中的项目。',
    '请先处理自动失败/阻塞项，再手测本清单。整批报告附manual-results.template.json时，可填写并用quality:analyze signoff导入；不会用人工签收覆盖自动失败。',
    '',
    ...report.manualRequired.flatMap((item) => [
      `## ${item.id} ${item.title}`,
      '',
      `原因：${item.reason}`,
      '',
      ...item.steps.map((step, index) => `${index + 1}. ${step}`),
      '',
      '可复制提示词：',
      '',
      '~~~text',
      item.prompt,
      '~~~',
      '',
      `预期：${item.expected}`,
      '',
      '反馈：通过/失败/未测；实际版本、系统、模型；发生时间；截图或诊断编号。',
      ''
    ])
  ].join('\n')
}

export async function saveEvidence(directory: string, report: QualityReport) {
  await writeFile(path.join(directory, 'manual-checks.md'), redact(manualDocument(report)))
  if (!['failed', 'incomplete', 'cancelled'].includes(report.outcome)) return
  const zip = new AdmZip()
  // Whitelist textual runner evidence. NEVER recursive userData, browser data, screenshots or generated files.
  const names = new Set([
    'report.json',
    'report.md',
    'manual-checks.md',
    'budget.json',
    'cost-summary.json',
    'cost-summary.md',
    'live-observations.json',
    'judge-results.json',
    'file-validation.json',
    'child-reports.json',
    'release-gate.md',
    ...report.cases
      .flatMap((entry) => entry.evidence)
      .filter(
        (name) =>
          /^[A-Z0-9-]+\.(log|tests\.json)$/.test(name) ||
          /^PACKAGE-(?:windows|mac|linux)-(?:arm64|x64)\.json$/.test(name)
      )
  ])
  for (const name of await readdir(directory))
    if (/^target-\d+-(?:chat|assistant)$/.test(name)) {
      names.add(`${name}/calls.json`)
      names.add(`${name}/ui-state.json`)
    }
  const manifest: Array<{ file: string; included: boolean; reason?: string }> = []
  let total = 0
  for (const name of names) {
    try {
      if (path.basename(name) !== name && !/^target-\d+-(?:chat|assistant)\/(?:calls|ui-state)\.json$/.test(name))
        throw new Error('not whitelisted')
      const file = path.join(directory, name)
      if (name.includes('/') && (await lstat(path.dirname(file))).isSymbolicLink()) throw new Error('symbolic target')
      if (path.relative(await realpath(directory), await realpath(file)) !== name.replaceAll('/', path.sep))
        throw new Error('escaped report directory')
      const info = await lstat(file)
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 32 * 1024 * 1024 ||
        total + info.size > 64 * 1024 * 1024
      )
        throw new Error('not regular file / size limit')
      const text = await readFile(file, 'utf8')
      const safe = name.endsWith('.json') ? JSON.stringify(sanitizeEvidence(JSON.parse(text)), null, 2) : redact(text)
      zip.addFile(name, Buffer.from(safe))
      total += info.size
      manifest.push({ file: name, included: true })
    } catch {
      manifest.push({
        file: name,
        included: false,
        reason: 'missing/unsafe/oversized/invalid; not silently treated as complete evidence'
      })
    }
  }
  zip.addFile('evidence-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))
  await writeFile(path.join(directory, 'failure-evidence.zip'), zip.toBuffer())
}
