import type { CallEvidence } from './gateway'

export interface TurnCost {
  id: string
  modelId: string
  providerRef: string
  entry: string
  round: number
  attempted?: boolean
  completed?: boolean
}

export function costSummary(turns: TurnCost[], calls: CallEvidence[], priced = true) {
  if (new Set(turns.map((turn) => turn.id)).size !== turns.length) throw new Error('重复用户轮次，拒绝重复计费汇总。')
  const ids = new Set(turns.map((turn) => turn.id))
  const unassignedCalls = calls.filter((call) => !ids.has(call.turnId)).length
  const groups = new Map<string, TurnCost[]>()
  for (const turn of turns) {
    const key = JSON.stringify([turn.providerRef, turn.modelId, turn.entry])
    groups.set(key, [...(groups.get(key) ?? []), turn])
  }
  return {
    unassignedCalls,
    groups: [...groups.values()].map((group) => {
      const ordered = group.toSorted((a, b) => a.round - b.round)
      const summarize = (through: number) => {
        const planned = ordered.filter((turn) => turn.round <= through)
        const attempted = planned.filter((turn) => turn.attempted !== false)
        const selected = new Set(attempted.map((turn) => turn.id))
        const requests = calls.filter((call) => selected.has(call.turnId))
        const known = requests.filter((call) => call.usageKnown && call.usage)
        const input = known.reduce((sum, call) => sum + call.usage!.input, 0)
        const output = known.reduce((sum, call) => sum + call.usage!.output, 0)
        const cacheRead = known.reduce((sum, call) => sum + call.usage!.cacheRead, 0)
        const missingUsage = requests.length - known.length
        const missingPrice = !priced || requests.some((call) => call.amount === null || !Number.isFinite(call.amount))
        const estimatedAmount = missingPrice ? null : requests.reduce((sum, call) => sum + call.amount!, 0)
        return {
          through,
          plannedUserTurns: planned.length,
          userTurns: selected.size,
          completedUserTurns: attempted.filter((turn) => turn.completed !== false).length,
          modelCalls: requests.length,
          input,
          output,
          cacheRead,
          totalTokensKnown: input + output,
          missingUsage,
          cacheReadRatio: missingUsage || input === 0 ? null : cacheRead / input,
          estimatedAmount,
          estimatedPerQuestion: selected.size && estimatedAmount !== null ? estimatedAmount / selected.size : null,
          missingPrice,
          amountIncludesConservativeReservations: requests.some((call) =>
            ['conservative-reservation', 'pending'].includes(call.amountBasis)
          ),
          failedCalls: requests.filter((call) => call.error || !call.completed).length,
          actualChannel: 'unknown',
          upstreamAccount: 'unknown',
          procurementCost: 'unknown'
        }
      }
      return {
        providerRef: group[0].providerRef,
        modelId: group[0].modelId,
        entry: group[0].entry,
        milestones: [1, 5, 10, 20].filter((round) => ordered.some((turn) => turn.round === round)).map(summarize),
        all: summarize(ordered.at(-1)!.round)
      }
    }),
    limitations: [
      '按隔离运行中的活动窗口归集；单问归因是范围估计，不是服务端taskId的已证实映射。不把底层请求条数当用户问题数。',
      '未取得真实渠道/账号和服务端结算，不能证明同上游、计算真实采购成本或承诺缓存冷启动。',
      '未知用量不补零；金额包含保守预留时不是精确实付成本。固定断言不能代替开放式语义质量评分。',
      '无报价验收的金额为未核算/null，不表示免费；混用分配的用例不相同，不能据此比较模型成本或推断全部组合已通过。'
    ]
  }
}

export function costMarkdown(summary: ReturnType<typeof costSummary>, currency: string) {
  const lines = [
    '# 双入口Token与费用观测',
    '',
    '金额是价格快照估算，不是采购成本或服务端账单。输入已包含缓存，不重复相加。未完成批次不可据此给出成本优劣结论。',
    '',
    '| 模型 | 入口 | 问题 已发/完成/计划 | 底层调用 | 已知输入 | 已知输出 | 已知缓存读取 | 缓存率 | 估算金额 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  for (const group of summary.groups) {
    const total = group.all
    lines.push(
      `| ${group.modelId.replaceAll('|', '\\|')} | ${group.entry} | ${total.userTurns}/${total.completedUserTurns}/${total.plannedUserTurns} | ${total.modelCalls} | ${total.input} | ${total.output} | ${total.cacheRead} | ${total.cacheReadRatio === null ? '未知' : (total.cacheReadRatio * 100).toFixed(1) + '%'} | ${total.estimatedAmount === null ? '未核算' : total.estimatedAmount.toFixed(9) + ' ' + currency + (total.amountIncludesConservativeReservations ? '（含保守预留）' : '')} |`
    )
  }
  lines.push(
    '',
    '## 同一会话累计对比',
    '',
    '以下是累计到该轮的观测，不是把每行金额再相加。未完整跑完时不要比较平均成本。',
    '',
    '| 模型 | 入口 | 截至轮数 | 完成/计划 | 底层调用 | 输入 | 输出 | 缓存读取 | 估算累计金额 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  )
  for (const group of summary.groups)
    for (const milestone of group.milestones)
      lines.push(
        `| ${group.modelId.replaceAll('|', '\\|')} | ${group.entry} | ${milestone.through} | ${milestone.completedUserTurns}/${milestone.plannedUserTurns} | ${milestone.modelCalls} | ${milestone.input} | ${milestone.output} | ${milestone.cacheRead} | ${milestone.estimatedAmount === null ? '未核算' : milestone.estimatedAmount.toFixed(9) + ' ' + currency + (milestone.amountIncludesConservativeReservations ? '（含保守预留）' : '')} |`
      )
  lines.push('', ...summary.limitations.map((line) => '- ' + line), '', `未归因调用：${summary.unassignedCalls}。`)
  return lines.join('\n') + '\n'
}
