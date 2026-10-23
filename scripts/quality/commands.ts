import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Command } from './process'
import type { Check } from './types'

const safeScripts = new Set([
  'test:lint',
  'typecheck',
  'format:check',
  'openapi:check',
  'skills:check',
  'validate:release',
  'smoke:opencode',
  'smoke:opencode:attachments'
])

export async function pnpmCommand(root: string, args: string[]): Promise<Command> {
  const cli = process.env.npm_execpath
  // pnpm scripts provide its JS entrypoint, avoiding cmd.exe / shell quoting on Windows.
  if (!cli || !/[/\\]pnpm\.(c?js|mjs)$/.test(cli)) {
    throw new Error('请通过 pnpm quality:* 启动，未找到可信的 pnpm JS 入口。')
  }
  await access(cli)
  return { file: process.execPath, args: [cli, ...args], cwd: root }
}

export async function buildCommand(check: Check, root: string, artifact: string, bunPath?: string): Promise<Command> {
  if (check.executor === 'vitest') {
    if (
      check.target.some(
        (target) => target.startsWith('-') || path.isAbsolute(target) || target.split(/[\\/]/).includes('..')
      )
    )
      throw new Error('Vitest 仅接受项目内测试路径，不接受额外选项。')
    // Vitest treats filters as optional matches; one valid filter must not hide a stale catalogue path.
    for (const target of check.target) {
      try {
        await access(path.join(root, target))
      } catch {
        throw new Error(`登记的测试路径不存在：${target}`)
      }
    }
    if (!check.target.length)
      return pnpmCommand(root, ['run', 'test', '--retry=0', '--reporter=json', `--outputFile=${artifact}`])
    return pnpmCommand(root, [
      'exec',
      'vitest',
      'run',
      ...check.target,
      '--silent',
      '--pool=forks',
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--retry=0',
      '--reporter=json',
      `--outputFile=${artifact}`
    ])
  }
  if (check.executor === 'script') {
    if (check.target.length !== 1) throw new Error('脚本参数不合法。')
    if (check.target[0] === 'i18n:check') return pnpmCommand(root, ['exec', 'tsx', 'scripts/check-i18n.ts'])
    if (!safeScripts.has(check.target[0])) throw new Error('质检入口不允许执行未登记脚本。')
    return pnpmCommand(root, ['run', check.target[0]])
  }
  if (check.executor === 'go-test' || check.executor === 'go-vet') {
    if (!check.target.length || check.target.some((target) => !/^\.\/(?:[a-z][a-z0-9_/-]*|\.\.\.)$/.test(target)))
      throw new Error('Go 包路径不合法。')
    return {
      file: 'go',
      args:
        check.executor === 'go-test'
          ? ['test', '-json', '-count=1', '-parallel=1', '-timeout=10m', ...check.target]
          : ['vet', ...check.target],
      cwd: root
    }
  }
  if (check.target.join() !== 'build:check') throw new Error('面板构建脚本不合法。')
  const bundled = path.join(os.homedir(), '.zen-ai', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun')
  let binary = bunPath
  if (!binary) {
    try {
      await access(bundled)
      binary = bundled
    } catch {
      binary = 'bun'
    }
  }
  return { file: binary, args: ['run', 'build:check'], cwd: path.join(root, 'web/default') }
}
