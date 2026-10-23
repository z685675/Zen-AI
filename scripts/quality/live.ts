import * as z from 'zod'

import { describeInputSizing, inputSizingPolicy } from './input-sizing'
import { fileKinds, matrixScenarios, tasksForTarget } from './matrix'
import { amount, planDigest, priceSchema, reserveNano, validatePrice } from './pricing'

// Completion usage can include reasoning tokens, not just visible answer text.
export const DEFAULT_OUTPUT_TOKENS_PER_REQUEST = 8192

const target = z.strictObject({
  family: z.enum(['gpt', 'claude', 'gemini', 'grok', 'other']),
  providerRef: z.string().min(1).max(128),
  modelId: z.string().min(1).max(200),
  contextWindowTokens: z.number().int().min(1024).max(200000).optional(),
  entries: z
    .array(z.enum(['chat', 'assistant']))
    .min(1)
    .max(2)
})

export const liveConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profile: z.enum(['quick', 'release', 'deep', 'cost']),
  allocation: z.enum(['all-models', 'mixed']).default('all-models'),
  targets: z.array(target).min(1),
  modules: z
    .array(z.enum(['files', 'history', 'memory']))
    .max(3)
    .optional(),
  formats: z.array(z.enum(fileKinds)).min(1).max(7).optional(),
  deep: z
    .strictObject({
      characters: z.number().int().min(1000).max(1000000),
      minimumObservedInputTokens: z.number().int().min(1000).max(200000),
      requireCompaction: z.boolean(),
      acknowledgedApproximateInputSizing: z.literal(true)
    })
    .optional(),
  vision: z
    .strictObject({
      maxImageTokensPerRequest: z.number().int().positive().max(200000),
      acknowledgedTokenBilling: z.literal(true)
    })
    .optional(),
  judge: z
    .strictObject({
      providerRef: z.string().min(1).max(128),
      modelId: z.string().min(1).max(200),
      maxRequests: z.number().int().min(4).max(100),
      maxAmount: z.number().positive().max(1000000),
      maxInputTokensPerRequest: z.number().int().min(4096).max(200000)
    })
    .optional(),
  providers: z
    .array(
      z.strictObject({
        providerRef: z.string().min(1).max(128),
        baseURL: z.string().url(),
        credentialEnv: z.string().regex(/^ZEN_QUALITY_[A-Z0-9_]+_KEY$/),
        group: z.string().min(1).max(128)
      })
    )
    .max(8)
    .optional(),
  prices: z.array(priceSchema).max(32).optional(),
  execution: z
    .strictObject({
      maxInputTokensPerRequest: z.number().int().min(1024).max(200000),
      requestTimeoutMs: z.number().int().min(1000).max(600000),
      turnTimeoutMs: z.number().int().min(1000).max(1800000),
      pauseMs: z.number().int().min(0).max(60000).default(20000),
      inputSizing: z.enum(['utf8-bytes', 'estimated-tokens']).optional(),
      costPromptFile: z.string().optional()
    })
    .optional(),
  budget: z.strictObject({
    mode: z.enum(['money', 'tokens']).default('money'),
    acknowledgedUnknownCost: z.literal(true).optional(),
    currency: z.enum(['CNY', 'USD']).optional(),
    maxAmount: z.number().min(0.000000001).max(1000000).finite().optional(),
    maxRequests: z.number().int().min(1).max(10000),
    maxRequestsPerTurn: z.number().int().min(1).max(100).default(20),
    maxOutputTokensPerRequest: z.number().int().min(1).max(32768),
    maxInputTokens: z.number().int().min(1),
    maxOutputTokens: z.number().int().min(1),
    timeoutMs: z.number().int().min(1000).max(86400000)
  })
})

/** Limit only the isolated file test, not the user's model or the paid gateway allowance. */
export function fileTestContextWindow(
  config: z.infer<typeof liveConfigSchema>,
  target: z.infer<typeof liveConfigSchema>['targets'][number],
  entry: string
): number | undefined {
  if (
    entry !== 'chat' ||
    config.profile !== 'release' ||
    !config.modules?.includes('files') ||
    inputSizingPolicy(config) !== 'estimated-tokens' ||
    !config.execution
  )
    return target.contextWindowTokens

  // The product defaults to a 200K window. A smaller approved input reserve,
  // especially with the gateway's x2 estimate, cannot fund that entire window.
  // Exercise the real compaction path under a declared smaller test capacity
  // instead of raising paid limits, clipping fixtures or rewriting requests.
  const inputCapacity = Math.floor(
    Math.max(0, config.execution.maxInputTokensPerRequest - 4096 - (config.vision?.maxImageTokensPerRequest ?? 0)) / 2
  )
  const outputCapacity = Math.min(32000, Math.max(8000, config.budget.maxOutputTokensPerRequest))
  return Math.min(target.contextWindowTokens ?? 200000, Math.max(1024, inputCapacity + outputCapacity))
}

export function planLive(value: unknown, now = Date.now()) {
  const config = liveConfigSchema.parse(value)
  const seen = new Set<string>()
  const blockers: string[] = []
  const estimates: Array<{ providerRef: string; modelId: string; currency: string; maximumPerRequest: number }> = []
  const assignments: Array<{
    modelId: string
    providerRef: string
    entry: string
    cases: string[]
    contextWindowTokens?: number
  }> = []
  const tokenOnly = config.budget.mode === 'tokens'
  if (tokenOnly) {
    if (!config.budget.acknowledgedUnknownCost) blockers.push('限量验收需要明确确认：费用未知，不提供人民币金额保证。')
    if (config.budget.maxAmount !== undefined || config.budget.currency !== undefined || config.prices?.length)
      blockers.push('限量验收不能混入金额预算或报价；请使用money模式。')
    if (config.judge) blockers.push('限量验收不启用额外付费裁判；需要时单独配置带报价的money批次。')
  } else if (!config.budget.currency || config.budget.maxAmount === undefined)
    blockers.push('金额验收需要明确币种、有效报价和金额上限。')
  if (!tokenOnly && config.execution?.inputSizing === 'estimated-tokens')
    blockers.push('常规近似Token预检仅适用于已确认费用未知的tokens模式；money模式保留原有保守筛查。')
  if (config.allocation === 'mixed') {
    if (['deep', 'cost'].includes(config.profile))
      blockers.push('容量/成本对比必须逐模型保持完整会话，不能混用分配用例。')
    const entries = [...config.targets[0].entries].sort().join(',')
    if (config.targets.some((item) => [...item.entries].sort().join(',') !== entries))
      blockers.push('混用验收的模型必须选择相同入口，避免用例分配遗漏。')
  }
  if (!config.execution) blockers.push('尚未设置单请求输入/输出、请求与任务超时边界。')
  else if (
    config.budget.maxInputTokens < config.execution.maxInputTokensPerRequest ||
    config.budget.maxOutputTokens < config.budget.maxOutputTokensPerRequest
  )
    blockers.push('本批Token上限不足以预留一条请求，请调整数量限制。')
  if (['release', 'deep'].includes(config.profile) && !config.modules?.length)
    blockers.push('release/deep必须明确选择files/history/memory子集，不能悄悄展开付费矩阵。')
  if (config.profile === 'deep' && (!config.deep || !config.modules?.includes('memory')))
    blockers.push('deep需要明确资料字符数、实测输入Token门槛及是否要求真实压缩。')
  if (
    config.modules?.includes('files') &&
    (config.formats ?? fileKinds).some((format) => ['png', 'jpg'].includes(format)) &&
    !config.vision
  )
    blockers.push('图片用例需要明确视觉Token预留及按Token计价确认，不沿用文字预算猜测图像费用。')
  for (const values of [config.modules, config.formats])
    if (values && new Set(values).size !== values.length) throw new Error('测试模块/文件格式重复。')
  if (config.profile === 'cost' && !config.execution?.costPromptFile) blockers.push('尚未指定经过核对的20轮题库。')
  if (new Set(config.providers?.map((provider) => provider.providerRef)).size !== (config.providers?.length ?? 0))
    throw new Error('Provider重复。')
  for (const provider of config.providers ?? []) {
    const url = new URL(provider.baseURL)
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      throw new Error('Provider（含裁判）必须为无凭据的HTTPS或loopback地址。')
  }
  const prices = new Set<string>()
  for (const price of config.prices ?? []) {
    const key = `${price.providerRef}\0${price.modelId}\0${price.basis}`
    if (prices.has(key)) throw new Error('报价重复。')
    prices.add(key)
  }
  let userTurns = 0
  if (config.judge) {
    const provider = config.providers?.find((item) => item.providerRef === config.judge!.providerRef)
    const price = config.prices?.find(
      (item) =>
        item.providerRef === config.judge!.providerRef &&
        item.modelId === config.judge!.modelId &&
        item.basis === 'key-charge'
    )
    if (!provider || !price) blockers.push('独立裁判缺少已批准Provider/有效报价。')
    else {
      try {
        validatePrice(price, now)
        if (price.currency !== config.budget.currency || price.group !== provider.group)
          throw new Error('裁判报价币种/分组不符。')
        estimates.push({
          providerRef: price.providerRef,
          modelId: price.modelId,
          currency: price.currency,
          maximumPerRequest: amount(reserveNano(price, config.judge.maxInputTokensPerRequest, 1000))
        })
      } catch (error) {
        blockers.push(`裁判：${String(error)}`)
      }
    }
  }
  for (const [index, target] of config.targets.entries()) {
    if (new Set(target.entries).size !== target.entries.length) throw new Error('入口重复。')
    const key = `${target.providerRef}\0${target.modelId}`
    if (seen.has(key)) throw new Error('模型目标重复。')
    seen.add(key)
    const provider = config.providers?.find((item) => item.providerRef === target.providerRef)
    const price = config.prices?.find(
      (item) =>
        item.providerRef === target.providerRef && item.modelId === target.modelId && item.basis === 'key-charge'
    )
    if (!provider) blockers.push(`${target.providerRef}：尚未明确授权端点和凭据环境变量引用。`)
    else {
      const url = new URL(provider.baseURL)
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
      )
        throw new Error('Provider必须是HTTPS或明确loopback地址，不允许URL携带凭据/查询参数。')
    }
    if (!price && !tokenOnly) blockers.push(`${target.modelId}：缺少所选Key适用报价，不读取公共默认价冒充。`)
    else if (price && !tokenOnly) {
      try {
        validatePrice(price, now)
        if (price.currency !== config.budget.currency || price.group !== provider?.group)
          throw new Error('报价币种/分组与所选Provider不匹配。')
        if (config.execution)
          estimates.push({
            providerRef: target.providerRef,
            modelId: target.modelId,
            currency: price.currency,
            maximumPerRequest: amount(
              reserveNano(price, config.execution.maxInputTokensPerRequest, config.budget.maxOutputTokensPerRequest)
            )
          })
      } catch (error) {
        blockers.push(`${target.modelId}：${error instanceof Error ? error.message : '报价无效'}`)
      }
    }
    if (
      config.profile === 'deep' &&
      (!target.contextWindowTokens ||
        !config.execution ||
        target.contextWindowTokens < config.execution.maxInputTokensPerRequest)
    )
      blockers.push(`${target.modelId}：深度测试必须核实模型/服务端有效上下文上限，且不小于单请求预留。`)
    const scenarios = matrixScenarios({ ...config, deepCharacters: config.deep?.characters })
    for (const entry of target.entries) {
      const cases =
        config.profile === 'cost'
          ? Array.from({ length: 20 }, (_, round) => `cost-${String(round + 1).padStart(2, '0')}`)
          : tasksForTarget(
              scenarios,
              config.profile,
              entry,
              ['quick', 'release'].includes(config.profile) ? config.allocation : 'all-models',
              index,
              config.targets.length
            ).map((task) => task.id)
      assignments.push({
        modelId: target.modelId,
        providerRef: target.providerRef,
        entry,
        cases,
        contextWindowTokens: fileTestContextWindow(config, target, entry)
      })
      userTurns += cases.length
    }
  }
  return {
    profile: config.profile,
    targets: config.targets,
    allocation: config.allocation,
    assignments,
    budget: config.budget,
    inputSizing: inputSizingPolicy(config),
    userTurns,
    executionAvailable: blockers.length === 0,
    blockers,
    estimates,
    conservativeBatchMaximum: estimates.length
      ? Math.max(...estimates.map((item) => item.maximumPerRequest)) * config.budget.maxRequests
      : null,
    approvalDigest: planDigest(config),
    limitations: [
      '预览不读取Provider Key，不发起模型请求；执行需明确批准本配置摘要。',
      '真实执行走OpenAI兼容chat/completions；图片需显式核实Token计价与预留，不冒充其他原生协议全覆盖。',
      'release/deep只执行明确选中的矩阵；字符数不是Token数，未达到实测容量/压缩门槛不能通过。',
      describeInputSizing(inputSizingPolicy(config)),
      '常规近似预检的AI对话文件验收按批准输入预留设置受限测试窗口，容量见assignments；不提高费用额度，不代表已验证模型200K真实容量。deep容量与cost对比不套用此限制。',
      tokenOnly
        ? '本批只限制请求数、Token预留和超时，费用未知，不保证人民币金额上限；缺失用量按预留占用。'
        : '金额为核实价格快照下的客户端预留/估算，不是上游结算保证；建议配合测试Key服务端额度。',
      '混用按关联用例组固定分配模型，连续记忆不换模型；未分配组合不代表已验证，失败不自动换模型掩盖。',
      '在隔离实例中只配置明确授权的测试模型；命名模型采用本批模型，和个人日常配置可能不同，成本报告须注明。'
    ]
  }
}

export class RequestBudget {
  private requests = 0
  private input = 0
  private output = 0
  private reservedInput = 0
  private reservedOutput = 0
  private stopped = false
  private next = 0
  private inFlight = new Map<number, { input: number; output: number }>()

  constructor(private readonly limits: { maxRequests: number; maxInputTokens: number; maxOutputTokens: number }) {
    for (const value of [limits.maxRequests, limits.maxInputTokens, limits.maxOutputTokens])
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid budget limit')
  }

  reserve(input: number, output: number) {
    if (![input, output].every((value) => Number.isSafeInteger(value) && value >= 0))
      throw new Error('Invalid reservation')
    if (
      this.stopped ||
      this.requests >= this.limits.maxRequests ||
      this.input + this.reservedInput + input > this.limits.maxInputTokens ||
      this.output + this.reservedOutput + output > this.limits.maxOutputTokens
    ) {
      throw new Error('Request/token budget exhausted')
    }
    const id = ++this.next
    this.requests++
    this.reservedInput += input
    this.reservedOutput += output
    this.inFlight.set(id, { input, output })
    return id
  }

  settle(id: number, usage?: { input: number; output: number }) {
    const reservation = this.inFlight.get(id)
    if (!reservation) throw new Error('Unknown or already settled reservation')
    if (usage && !Object.values(usage).every((value) => Number.isSafeInteger(value) && value >= 0))
      throw new Error('Invalid usage')
    this.inFlight.delete(id)
    this.reservedInput -= reservation.input
    this.reservedOutput -= reservation.output
    // Missing usage is charged at its reservation, never treated as a free failed request.
    this.input += usage?.input ?? reservation.input
    this.output += usage?.output ?? reservation.output
    if (this.input > this.limits.maxInputTokens || this.output > this.limits.maxOutputTokens) this.stopped = true
  }

  stop() {
    this.stopped = true
  }

  snapshot() {
    return {
      requests: this.requests,
      input: this.input,
      output: this.output,
      reservedInput: this.reservedInput,
      reservedOutput: this.reservedOutput,
      stopped: this.stopped,
      inFlight: this.inFlight.size
    }
  }
}
