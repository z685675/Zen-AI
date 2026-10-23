import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { inputSizingPolicy } from './input-sizing'
import { liveConfigSchema, planLive } from './live'
import { matrixScenarios } from './matrix'
import { planDigest } from './pricing'
import { loadCostPrompts } from './scenarios'
import type { Revision } from './types'

async function fileHash(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function buildDigest(directory: string) {
  const root = await realpath(directory)
  const files: Array<[string, string]> = []
  let bytes = 0
  const visit = async (folder: string) => {
    for (const name of (await readdir(folder)).sort()) {
      const file = path.join(folder, name)
      const info = await lstat(file)
      if (info.isSymbolicLink()) throw new Error('构建目录包含符号链接，不能确认批准范围。')
      if (info.isDirectory()) await visit(file)
      else {
        if (!info.isFile() || files.length >= 10000 || (bytes += info.size) > 1024 ** 3)
          throw new Error('构建快照不完整/过大。')
        files.push([path.relative(root, file).replaceAll('\\', '/'), await fileHash(file)])
      }
    }
  }
  await visit(root)
  if (!files.some(([file]) => file === 'main/index.js') || !files.some(([file]) => file === 'renderer/index.html'))
    throw new Error('缺少完整的Electron构建，请先pnpm build。')
  return planDigest(files)
}

async function nativeDigest(root: string) {
  const require = createRequire(path.join(root, 'package.json'))
  const native = createRequire(require.resolve('opencode-ai/package.json'))
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const candidates =
    process.arch === 'x64' ? [`opencode-${os}-x64-baseline`, `opencode-${os}-x64`] : [`opencode-${os}-${process.arch}`]
  for (const candidate of candidates) {
    let manifest: string
    try {
      manifest = native.resolve(`${candidate}/package.json`)
    } catch {
      continue
    }
    const binary = path.join(path.dirname(manifest), 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode')
    return { version: JSON.parse(await readFile(manifest, 'utf8')).version as string, binary: await fileHash(binary) }
  }
  throw new Error('缺少本机OpenCode运行时。')
}

// Approval binds what will actually run, not just a JSON filename that can be edited afterwards.
export async function prepareLivePlan(value: unknown, root: string, revision: Revision) {
  const config = liveConfigSchema.parse(value)
  const base = planLive(config)
  const blockers = [...base.blockers]
  let scenarios = matrixScenarios({ ...config, deepCharacters: config.deep?.characters })
  if (config.profile === 'cost' && config.execution?.costPromptFile) {
    try {
      scenarios = await loadCostPrompts(path.resolve(root, config.execution.costPromptFile))
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : '题库不可读取。')
    }
  }
  let build: string | null = null
  let native: Awaited<ReturnType<typeof nativeDigest>> | null = null
  try {
    build = await buildDigest(path.join(root, 'out'))
  } catch (error) {
    blockers.push(String(error))
  }
  if (config.targets.some((target) => target.entries.includes('assistant'))) {
    try {
      native = await nativeDigest(root)
    } catch (error) {
      blockers.push(String(error))
    }
  }
  if (!revision.head || !revision.changeDigest || revision.error) blockers.push('源代码快照不可确认。')
  const snapshot = {
    head: revision.head,
    source: revision.changeDigest,
    build,
    native,
    prompts: planDigest(scenarios),
    platform: process.platform,
    arch: process.arch
  }
  return {
    scenarios,
    plan: {
      ...base,
      blockers,
      executionAvailable: blockers.length === 0,
      snapshot,
      comparisonDigest: planDigest({
        targets: config.targets,
        providers: config.providers?.map(({ providerRef, baseURL, group }) => ({ providerRef, baseURL, group })),
        prices: config.prices?.map(({ providerRef, modelId, currency, group, tiers, basis }) => ({
          providerRef,
          modelId,
          currency,
          group,
          tiers,
          basis
        })),
        profile: config.profile,
        allocation: config.allocation,
        budgetMode: config.budget.mode,
        requestLimits: {
          maxRequests: config.budget.maxRequests,
          maxRequestsPerTurn: config.budget.maxRequestsPerTurn,
          maxInputTokens: config.budget.maxInputTokens,
          maxOutputTokens: config.budget.maxOutputTokens
        },
        modules: config.modules,
        formats: config.formats,
        deep: config.deep,
        vision: config.vision,
        pauseMs: config.execution?.pauseMs,
        maxInput: config.execution?.maxInputTokensPerRequest,
        inputSizing: inputSizingPolicy(config),
        testContextWindows: base.assignments.map(({ providerRef, modelId, entry, contextWindowTokens }) => ({
          providerRef,
          modelId,
          entry,
          contextWindowTokens
        })),
        maxOutput: config.budget.maxOutputTokensPerRequest,
        prompts: snapshot.prompts
      }),
      approvalDigest: planDigest({ config, snapshot })
    }
  }
}
