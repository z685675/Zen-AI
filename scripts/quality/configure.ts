import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'

import { QUALITY_REQUEST_TIMEOUT_MS } from '../../packages/shared/agents/opencodeLimits'
import { chooseFileInputs, chooseModules, chooseProviderURL } from './choices'
import { DEFAULT_OUTPUT_TOKENS_PER_REQUEST, liveConfigSchema, planLive } from './live'
import { chooseModels, type fetchModels } from './models'
import { redact } from './process'

export function numberAnswer(text: string) {
  if (!text.trim() || !/^\d+(?:\.\d+)?$/.test(text.trim())) throw new Error('必须明确填写数字；空白不会当作0元。')
  const value = Number(text.trim())
  if (!Number.isFinite(value)) throw new Error('数字无效。')
  return value
}

export async function configure(io?: {
  ask: (question: string) => Promise<string>
  write: (text: string) => void
  directory: string
  discover: typeof fetchModels
}) {
  const terminal = io ? undefined : createInterface({ input: process.stdin, output: process.stdout })
  const ask = io?.ask ?? (async (question: string) => (await terminal!.question(question + '\n> ')).trim())
  const write =
    io?.write ??
    ((text: string) => {
      process.stdout.write(text)
    })
  try {
    write('高级配置向导：可选择任意数量模型；只保存不含Key的配置，不启动生成。日常直接使用pnpm quality:check。\n')
    const baseURL = await chooseProviderURL({ ask, write })
    const credentialEnv =
      (await ask('专用测试Key环境变量名（回车使用ZEN_QUALITY_SELECTED_KEY；Key不要填写在这里）')) ||
      'ZEN_QUALITY_SELECTED_KEY'
    const group = (await ask('测试Key所属分组（回车default；不会修改实际Key分组）')) || 'default'
    const chosen = await chooseModels({ baseURL, credentialEnv, ask, write, discover: io?.discover })
    write('已选择：' + chosen.map((model) => model.id).join('、') + '\n')
    const profile = (await ask('验收范围：quick快速（回车默认）、release文件/历史/记忆、deep容量压缩')) || 'quick'
    if (!['quick', 'release', 'deep'].includes(profile))
      throw new Error('验收范围无效；20轮实验请使用quality:experiment。')
    const entries = ((await ask('测试入口：chat,assistant（回车默认两个），或只填chat/assistant')) || 'chat,assistant')
      .split(',')
      .map((value) => value.trim())
    const modules = ['release', 'deep'].includes(profile) ? await chooseModules({ ask, write }, profile) : undefined
    const { formats, vision } = modules?.includes('files') ? await chooseFileInputs({ ask, write }) : {}
    const deep =
      profile === 'deep'
        ? {
            characters: numberAnswer(await ask('长资料字符数（不是Token数）')),
            minimumObservedInputTokens: numberAnswer(await ask('实际请求至少要观察到多少输入Token？不足记为未验证')),
            requireCompaction: (await ask('必须观察到真实整理/原生压缩？yes或no')) === 'yes',
            acknowledgedApproximateInputSizing: true
          }
        : undefined
    if (deep && (await ask('深度输入使用近似估算，不是精确Tokenizer保证；同意才继续，填yes')) !== 'yes')
      throw new Error('未确认深度估算边界。')
    const targets: unknown[] = []
    for (const model of chosen) {
      const family = model.family ?? 'other'
      const contextWindowTokens =
        profile === 'deep' ? numberAnswer(await ask(`${model.id}经核实的有效上下文上限（最多200000）`)) : undefined
      targets.push({ family, providerRef: 'selected-provider', modelId: model.id, entries, contextWindowTokens })
    }
    const maxRequests = numberAnswer((await ask('本批底层请求上限（含命名/压缩/工具循环；回车60）')) || '60')
    write(
      `默认限制：单请求输入预留128000、输出${DEFAULT_OUTPUT_TOKENS_PER_REQUEST}（包含上游计入的推理Token）；累计输入1000000、输出60000 Token；每轮最多8条底层请求。达到任一限制提前停止，未测项不算通过。\n`
    )
    const advanced = (await ask('需要自定义上述Token限制吗？填yes；回车使用默认值（深度/20轮可能需调大）')) === 'yes'
    const maxOutputTokensPerRequest = advanced
      ? numberAnswer(await ask('每条请求输出Token预留（包含上游计入的推理Token）'))
      : DEFAULT_OUTPUT_TOKENS_PER_REQUEST
    const maxInputTokensPerRequest = advanced ? numberAnswer(await ask('每条请求输入Token保守预留')) : 128000
    const maxInputTokens = advanced ? numberAnswer(await ask('本批累计输入Token预留上限')) : 1000000
    const maxOutputTokens = advanced ? numberAnswer(await ask('本批累计输出Token上限')) : 60000
    write(
      `超时默认：单请求${QUALITY_REQUEST_TIMEOUT_MS}ms、本轮300000ms；轮间pause 20000ms仅用于节流，不是首字或辅助请求超时。保存后可显式配置更短超时。\n`
    )
    write(
      '输入预检采用近似Token估算（常规×2安全余量），另加图像预留和4096协议余量；非精确Tokenizer或硬费用上限，实际超限停止后续请求。\n'
    )
    if (
      (await ask(
        '确认：这些模型请求可能收费；费用未知，不保证人民币金额上限。按以上数量/Token/超时限量验收，填yes确认'
      )) !== 'yes'
    )
      throw new Error('未确认，不保存配置或发起生成。')
    const config = liveConfigSchema.parse({
      schemaVersion: 1,
      profile,
      allocation: profile === 'deep' ? 'all-models' : 'mixed',
      modules,
      formats,
      vision,
      deep,
      targets,
      providers: [{ providerRef: 'selected-provider', baseURL, group, credentialEnv }],
      execution: {
        maxInputTokensPerRequest,
        inputSizing: 'estimated-tokens',
        requestTimeoutMs: QUALITY_REQUEST_TIMEOUT_MS,
        turnTimeoutMs: 300000,
        pauseMs: 20000
      },
      budget: {
        mode: 'tokens',
        acknowledgedUnknownCost: true,
        maxRequests,
        maxRequestsPerTurn: 8,
        maxOutputTokensPerRequest,
        maxInputTokens,
        maxOutputTokens,
        timeoutMs: 7200000
      }
    })
    const plan = planLive(config)
    if (!plan.executionAvailable) throw new Error(`配置未通过预检：${plan.blockers.join('；')}`)
    const directory = path.resolve(io?.directory ?? 'local/quality-configs')
    await mkdir(directory, { recursive: true })
    const file = path.join(directory, `live-${Date.now()}.json`)
    await writeFile(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    write(`已保存：${file}\n` + JSON.stringify({ ...plan, approvalDigest: undefined }, null, 2) + '\n')
    write(
      '没有保存Key或启动生成。下一步quality:live --project ai --config 上述路径 --dry-run；核对实际用例分配与限制后批准摘要才执行。金额预算模式仍可在单独配置中使用。\n'
    )
    return { file, config }
  } finally {
    terminal?.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename)
  configure().catch((error) => {
    process.stderr.write(redact(String(error)) + '\n')
    process.exitCode = 1
  })
