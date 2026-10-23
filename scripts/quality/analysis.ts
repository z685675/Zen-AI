import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as z from 'zod'

import type { CallEvidence } from './gateway'
import { planDigest } from './pricing'
import { redact } from './process'

/** RFC4180 subset including BOM, escaped quotes and embedded newlines. Never split CSV with commas. */
export function parseCSV(text: string) {
  if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error('CSV超过64MB。')
  const rows: string[][] = []
  let row: string[] = [],
    field = '',
    quoted = false,
    closed = false
  const input = text.replace(/^\uFEFF/, '')
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index++
        } else {
          quoted = false
          closed = true
        }
      } else field += char
    } else if (char === '"' && !field && !closed) quoted = true
    else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field)
      field = ''
      closed = false
      if (char !== ',') {
        if (char === '\r' && input[index + 1] === '\n') index++
        rows.push(row)
        row = []
      }
    } else {
      if (closed || char === '"') throw new Error('无效CSV引号。')
      field += char
    }
    if (rows.length > 200000 || field.length > 1024 * 1024) throw new Error('CSV行数/字段过大。')
  }
  if (quoted) throw new Error('CSV引号未关闭。')
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  if (
    !rows.length ||
    new Set(rows[0]).size !== rows[0].length ||
    rows.slice(1).some((value) => value.length !== rows[0].length)
  )
    throw new Error('CSV列不完整或重复。')
  return rows.slice(1).map((value) => Object.fromEntries(rows[0].map((name, index) => [name, value[index]])))
}

export function reconcileCalls(calls: CallEvidence[], rows: Record<string, string>[], currency: string) {
  const ids = new Set<string>()
  for (const call of calls)
    if (call.requestId) {
      if (ids.has(call.requestId)) throw new Error('本地请求ID重复，不能精确对账。')
      ids.add(call.requestId)
    }
  const selected = rows.filter((row) => ids.has(row['请求ID'] ?? row.request_id))
  const count = (value: string | undefined) => {
    if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error('服务端Token字段缺失/无效。')
    return Number(value)
  }
  const matches = calls.map((call) => {
    const found = selected.filter((row) => (row['请求ID'] ?? row.request_id) === call.requestId)
    if (!call.requestId || found.length !== 1 || !call.usage)
      return {
        sequence: call.sequence,
        status: found.length > 1 ? 'ambiguous' : 'usage_pending',
        requestId: call.requestId ?? null
      }
    const row = found[0]
    const input = count(row['输入Token（含缓存）'] ?? row.prompt_tokens)
    const output = count(row['输出Token'] ?? row.completion_tokens)
    const cache = count(row['缓存Token（输入子集）'] ?? row.cache_tokens)
    const equal =
      input === call.usage.input &&
      output === call.usage.output &&
      cache === call.usage.cacheRead + call.usage.cacheWrite
    const debitText = row['净扣费（USD）'] ?? row.debit_usd
    const debit = debitText && /^\d+(?:\.\d+)?$/.test(debitText) ? Number(debitText) : null
    return {
      sequence: call.sequence,
      requestId: call.requestId,
      status: equal ? 'matched' : 'mismatch',
      server: { input, output, cache, debitUSD: debit },
      estimateAmount: call.amount,
      difference:
        currency === 'USD' && debit !== null && call.amount !== null && call.amountBasis === 'priced-usage'
          ? debit - call.amount
          : null
    }
  })
  return {
    matches,
    status: matches.some((match) => match.status === 'mismatch')
      ? 'mismatch'
      : matches.length > 0 && matches.every((match) => match.status === 'matched')
        ? 'matched'
        : 'usage_pending',
    unrelatedRowsIgnored: rows.length - selected.length,
    basis: 'exact-response-request-id-only; task/time proximity never invents a match',
    inputIncludesCache: true,
    procurementCost: 'unknown'
  }
}

export function compareCosts(before: any, after: any, beforePlan: any, afterPlan: any) {
  if (!beforePlan?.comparisonDigest || beforePlan.comparisonDigest !== afterPlan?.comparisonDigest)
    throw new Error('模型/报价/节奏/题库配置不一致或缺少快照，不能作配对成本比较。')
  if (!Array.isArray(before.groups) || !Array.isArray(after.groups)) throw new Error('缺少成本分组。')
  return before.groups.map((group: any) => {
    const other = after.groups.find(
      (candidate: any) =>
        candidate.providerRef === group.providerRef &&
        candidate.modelId === group.modelId &&
        candidate.entry === group.entry
    )
    if (
      !other ||
      group.all.completedUserTurns !== group.all.plannedUserTurns ||
      other.all.completedUserTurns !== other.all.plannedUserTurns ||
      group.all.plannedUserTurns !== other.all.plannedUserTurns ||
      group.all.missingUsage ||
      other.all.missingUsage ||
      group.all.failedCalls ||
      other.all.failedCalls ||
      group.all.amountIncludesConservativeReservations ||
      other.all.amountIncludesConservativeReservations
    )
      return { modelId: group.modelId, entry: group.entry, status: 'incomplete-not-comparable' }
    if (!Number.isFinite(group.all.estimatedAmount) || !Number.isFinite(other.all.estimatedAmount)) {
      const fields = ['input', 'output', 'cacheRead', 'modelCalls'] as const
      if (
        beforePlan.budget?.mode !== 'tokens' ||
        afterPlan.budget?.mode !== 'tokens' ||
        fields.some(
          (field) => ![group.all[field], other.all[field]].every((value) => Number.isFinite(value) && value >= 0)
        )
      )
        return { modelId: group.modelId, entry: group.entry, status: 'incomplete-not-comparable' }
      return {
        modelId: group.modelId,
        entry: group.entry,
        status: 'observational-usage-only',
        before: null,
        after: null,
        delta: null,
        cost: 'unknown',
        usage: Object.fromEntries(
          fields.map((field) => [
            field,
            {
              before: group.all[field],
              after: other.all[field],
              delta: other.all[field] - group.all[field]
            }
          ])
        ),
        cacheReadRatio: { before: group.all.cacheReadRatio ?? null, after: other.all.cacheReadRatio ?? null },
        caveat: '仅比较已知Token与缓存观测；费用未核算，上游渠道/账号及共享缓存未固定，不能推导金额节省或版本因果。'
      }
    }
    return {
      modelId: group.modelId,
      entry: group.entry,
      status: 'observational-only',
      before: group.all.estimatedAmount,
      after: other.all.estimatedAmount,
      delta: other.all.estimatedAmount - group.all.estimatedAmount,
      caveat: '上游渠道/账号及共享缓存未固定，不能把差异直接归因于软件版本。'
    }
  })
}

const receiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  sourceDigest: z.string().min(1),
  tester: z.string().min(1),
  results: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        status: z.enum(['passed', 'failed', 'not_run']),
        system: z.string().min(1),
        evidence: z.string().min(1),
        note: z.string()
      })
    )
    .min(1)
})

export async function signoff(directory: string, file: string) {
  const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'))
  const receipt = receiptSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  if (receipt.runId !== report.runId || receipt.sourceDigest !== planDigest(report.revisions))
    throw new Error('人工结果不是同一次代码验收，拒绝签收。')
  if (new Set(receipt.results.map((item) => item.id)).size !== receipt.results.length) throw new Error('人工项目重复。')
  const required = new Set(report.manualRequired.map((item: any) => item.id))
  if (receipt.results.some((item) => !required.has(item.id))) throw new Error('人工结果包含未登记项目。')
  const missing = [...required].filter(
    (id) => !receipt.results.some((item) => item.id === id && item.status === 'passed')
  )
  const releaseReady = report.outcome === 'passed' && missing.length === 0
  // Human receipt is separate; do not turn a failed automatic result green.
  const result = {
    releaseReady,
    automaticOutcome: report.outcome,
    pendingManual: missing,
    receipt,
    basis: 'operator-attested-not-cryptographic-signature'
  }
  await writeFile(path.join(directory, 'manual-signoff.json'), JSON.stringify(result, null, 2))
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const [command, first, second, third] = process.argv.slice(2)
  Promise.resolve()
    .then(async () => {
      if (command === 'signoff' && first && second && !third) return signoff(path.resolve(first), path.resolve(second))
      if (command === 'reconcile' && first && second && !third) {
        const calls = JSON.parse(await readFile(first, 'utf8'))
        return reconcileCalls(calls.calls, parseCSV(await readFile(second, 'utf8')), calls.currency ?? 'unknown')
      }
      if (command === 'compare' && first && second && !third) {
        const [before, after] = await Promise.all(
          [first, second].map(async (directory) => ({
            report: JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')),
            costs: JSON.parse(await readFile(path.join(directory, 'cost-summary.json'), 'utf8'))
          }))
        )
        return compareCosts(before.costs, after.costs, before.report.livePlan, after.report.livePlan)
      }
      throw new Error(
        '用法：quality:analyze signoff 报告目录 人工结果.json；reconcile calls.json usage-logs.csv；compare 旧报告目录 新报告目录'
      )
    })
    .then((value) => {
      process.stdout.write(JSON.stringify(value, null, 2) + '\n')
      if (!Array.isArray(value) && ('releaseReady' in value ? !value.releaseReady : value.status !== 'matched'))
        process.exitCode = 2
    })
    .catch((error) => {
      process.stderr.write(redact(String(error)) + '\n')
      process.exitCode = 1
    })
}
