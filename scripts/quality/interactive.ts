import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { QUALITY_REQUEST_TIMEOUT_MS } from '../../packages/shared/agents/opencodeLimits'
import { prepareLivePlan } from './approval'
import { chooseFileInputs, chooseModules, chooseProviderURL } from './choices'
import { pnpmCommand } from './commands'
import { DEFAULT_OUTPUT_TOKENS_PER_REQUEST, liveConfigSchema, planLive } from './live'
import { chooseModels, type fetchModels } from './models'
import { execute, redact } from './process'
import { runQuality } from './run'
import { loadCostPrompts } from './scenarios'
import { inspectRevision } from './selection'
import { askTerminal, readSecret } from './terminal'

export function interactiveOptions(args: string[]) {
  const remaining = [...args]
  const profile = remaining[0] && !remaining[0].startsWith('--') ? remaining.shift()! : 'quick'
  if (!['quick', 'release', 'deep', 'cost'].includes(profile))
    throw new Error(
      '用法：pnpm quality:check [quick|release|deep]；20轮实验用pnpm quality:experiment --prompts 文本路径。'
    )
  const options: Record<string, string> = {}
  const flags = [
    '--prompts',
    '--entries',
    '--max-requests',
    '--max-input-tokens',
    '--max-output-tokens',
    '--output-reserve',
    '--input-reserve',
    '--request-timeout-ms',
    '--turn-timeout-ms',
    '--pause-ms'
  ]
  while (remaining.length) {
    const flag = remaining.shift()!
    const value = remaining.shift()
    if (!flags.includes(flag) || flag in options || !value || value.startsWith('--'))
      throw new Error(`参数无效：${flag}`)
    options[flag] = value
  }
  if ((profile === 'cost') !== Boolean(options['--prompts']))
    throw new Error('20轮实验必须提供--prompts 文本路径；常规验收不读取20轮题库。')
  const entries = (options['--entries'] ?? 'chat,assistant').split(',')
  if (
    !entries.length ||
    new Set(entries).size !== entries.length ||
    entries.some((entry) => !['chat', 'assistant'].includes(entry))
  )
    throw new Error('--entries只能为chat、assistant或chat,assistant。')
  const number = (flag: string, fallback: number) => {
    if (!(flag in options)) return fallback
    if (!/^\d+$/.test(options[flag]) || !Number.isSafeInteger(Number(options[flag])))
      throw new Error(`参数必须是整数：${flag}`)
    return Number(options[flag])
  }
  return { profile, options, entries, number }
}

async function buildForTest(root: string, directory: string, signal?: AbortSignal) {
  const command = await pnpmCommand(root, ['run', 'build'])
  const result = await execute(command, { timeoutMs: 1200000, signal })
  await writeFile(path.join(directory, 'build.log'), redact(result.stdout + '\n' + result.stderr))
  if (result.exitCode !== 0 || result.cancelled || result.timedOut || result.error || result.terminationUnconfirmed)
    throw new Error('开发构建未正常完成，未启动模型测试。详情见本次目录的build.log。')
}

interface InteractiveIO {
  ask: (question: string) => Promise<string>
  secret: (question: string) => Promise<string>
  write: (text: string) => void
  discover?: typeof fetchModels
  build: typeof buildForTest
  inspect: typeof inspectRevision
  prepare: typeof prepareLivePlan
  run: (options: Parameters<typeof runQuality>[0], root: string, signal?: AbortSignal) => Promise<{ exitCode: number }>
}

/** The explicit interactive entrypoint authorizes only the selected batch; advanced --approve remains unchanged. */
export async function interactive(
  args: string[],
  root = path.resolve(__dirname, '../..'),
  signal?: AbortSignal,
  dependencies: Partial<InteractiveIO> = {}
) {
  const selected = interactiveOptions(args)
  const io: InteractiveIO = {
    ask: (question) => askTerminal(question, signal),
    secret: (question) => readSecret(question, signal),
    write: (text) => {
      process.stdout.write(text)
    },
    build: buildForTest,
    inspect: inspectRevision,
    prepare: prepareLivePlan,
    run: runQuality,
    ...dependencies
  }
  const directory = path.join(root, 'local/quality-reports', `interactive-${Date.now()}-${randomUUID().slice(0, 8)}`)
  await mkdir(directory, { recursive: true })
  const credentialEnv = `ZEN_QUALITY_SESSION_${randomUUID().replaceAll('-', '').toUpperCase()}_KEY`
  let secret = ''
  const checkCancelled = () => {
    if (signal?.aborted) throw new Error('已取消。')
  }
  io.write(`本次报告目录：${directory}\n`)
  io.write(
    '本命令在选完模型和范围后自动开始真实模型测试，可能收费；不保证人民币金额上限。Ctrl+C可取消，选模时q退出。Key不写入配置、报告或软件设置，结束时清理。\n'
  )
  try {
    if (selected.profile === 'cost') await loadCostPrompts(path.resolve(root, selected.options['--prompts']))
    checkCancelled()
    io.write('正在准备最新开发构建，构建日志保存在本次目录的build.log…\n')
    await io.build(root, directory, signal)
    checkCancelled()
    secret = await io.secret('专用测试API Key（隐藏输入，回车继续）')
    if (!secret || /\s/.test(secret)) throw new Error('Key不能为空或包含空白。')
    process.env[credentialEnv] = secret
    const baseURL = await chooseProviderURL(io)
    const models = await chooseModels({
      baseURL,
      credentialEnv,
      ask: io.ask,
      write: io.write,
      discover: io.discover,
      signal,
      selectionPrompt: '选择一个或多个模型序号（如1或1,4,9）；选完范围后自动开始测试。/关键词搜索，r刷新，q取消'
    })
    const modules = ['release', 'deep'].includes(selected.profile)
      ? await chooseModules(io, selected.profile)
      : undefined
    const { formats, vision } = modules?.includes('files') ? await chooseFileInputs(io) : {}
    const deep =
      selected.profile === 'deep'
        ? {
            characters: Number(await io.ask('长资料字符数（不是Token数；1000–1000000）')),
            minimumObservedInputTokens: Number(await io.ask('实测输入Token门槛（1000–200000；未达到记未验证）')),
            requireCompaction: (await io.ask('是否要求真实整理/原生压缩证据？yes/no')) === 'yes',
            acknowledgedApproximateInputSizing: true
          }
        : undefined
    const targets: unknown[] = []
    for (const model of models)
      targets.push({
        family: model.family ?? 'other',
        providerRef: 'selected-provider',
        modelId: model.id,
        entries: selected.entries,
        contextWindowTokens: deep ? Number(await io.ask(`${model.id}经核实的有效上下文上限（最多200000）`)) : undefined
      })
    let config = liveConfigSchema.parse({
      schemaVersion: 1,
      profile: selected.profile,
      allocation: ['deep', 'cost'].includes(selected.profile) ? 'all-models' : 'mixed',
      targets,
      modules,
      formats,
      vision,
      deep,
      providers: [{ providerRef: 'selected-provider', baseURL, group: 'default', credentialEnv }],
      execution: {
        maxInputTokensPerRequest: selected.number('--input-reserve', 128000),
        inputSizing: 'estimated-tokens',
        requestTimeoutMs: selected.number('--request-timeout-ms', QUALITY_REQUEST_TIMEOUT_MS),
        turnTimeoutMs: selected.number('--turn-timeout-ms', 300000),
        pauseMs: selected.number('--pause-ms', 20000),
        costPromptFile: selected.profile === 'cost' ? path.resolve(root, selected.options['--prompts']) : undefined
      },
      budget: {
        mode: 'tokens',
        acknowledgedUnknownCost: true,
        maxRequests: 60,
        maxRequestsPerTurn: 8,
        maxOutputTokensPerRequest: selected.number('--output-reserve', DEFAULT_OUTPUT_TOKENS_PER_REQUEST),
        maxInputTokens: 1000000,
        maxOutputTokens: 60000,
        timeoutMs: selected.profile === 'cost' ? 86400000 : 7200000
      }
    })
    const userTurns = planLive(config).userTurns
    config = liveConfigSchema.parse({
      ...config,
      budget: {
        ...config.budget,
        maxRequests: selected.number('--max-requests', Math.min(10000, Math.max(60, userTurns * 8))),
        maxInputTokens: selected.number(
          '--max-input-tokens',
          Math.max(1000000, userTurns * config.execution!.maxInputTokensPerRequest)
        ),
        maxOutputTokens: selected.number('--max-output-tokens', Math.max(60000, userTurns * 4000))
      }
    })
    checkCancelled()
    const { plan } = await io.prepare(config, root, await io.inspect(root, 'HEAD'))
    await writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan, null, 2))
    if (!plan.executionAvailable) throw new Error(`预检未通过，未发送模型生成请求：${plan.blockers.join('；')}`)
    io.write(
      `模型：${models.map((model) => model.id).join('、')}\n范围：${selected.profile}；入口：${selected.entries.join(',')}；计划用户轮次：${plan.userTurns}\n`
    )
    io.write(
      `上限：${config.budget.maxRequests}条底层请求，累计输入${config.budget.maxInputTokens}、输出${config.budget.maxOutputTokens} Token；费用未知。\n开始测试，报告会持续写入本次目录。\n`
    )
    io.write(
      `单请求预留：输入${config.execution!.maxInputTokensPerRequest}、输出${config.budget.maxOutputTokensPerRequest} Token；输出包含上游计入的推理Token。可用--output-reserve调整，累计上限不会随之自动增加。若上游超出所传限制，已产生用量无法撤销，工具会记录实耗并停止后续请求。\n`
    )
    io.write(
      '输入预检采用近似Token估算（常规模式×2安全余量，深度模式沿用明确确认的估算），另加图像预留和4096协议余量；不再将中文UTF-8字节数当作Token数，不保证精确Token或硬费用上限。\n'
    )
    for (const assignment of plan.assignments)
      if (assignment.contextWindowTokens)
        io.write(
          `${assignment.modelId} / ${assignment.entry}：本批测试上下文窗口${assignment.contextWindowTokens} Token（不代表已验证上游真实容量）。\n`
        )
    io.write(
      `超时：单请求${config.execution!.requestTimeoutMs}ms，本轮${config.execution!.turnTimeoutMs}ms；轮间pause ${config.execution!.pauseMs}ms仅用于节流，不是首字或辅助请求超时。\n`
    )
    checkCancelled()
    const result = await io.run(
      {
        mode: 'live',
        projects: ['ai'],
        dryRun: false,
        liveValue: config,
        approval: plan.approvalDigest,
        reportDirectory: directory
      },
      root,
      signal
    )
    return { ...result, directory }
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error))
      .split(secret || '\0')
      .join('[REDACTED]')
    await writeFile(path.join(directory, 'setup-error.txt'), message + '\n')
    throw new Error(message)
  } finally {
    delete process.env[credentialEnv]
    secret = ''
    io.write(`本次凭据已清理。报告目录：${directory}\n`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  interactive(process.argv.slice(2), undefined, controller.signal)
    .then(({ exitCode }) => {
      process.exitCode = exitCode
    })
    .catch((error) => {
      process.stderr.write(redact(String(error)) + '\n')
      process.exitCode = controller.signal.aborted || /已取消|AbortError/.test(String(error)) ? 130 : 1
    })
    .finally(() => {
      process.off('SIGINT', cancel)
      process.off('SIGTERM', cancel)
    })
}
