import { type ChildProcess, fork, spawn } from 'node:child_process'

import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk'

export function isClaudeJavaScriptProcess(options: SpawnOptions): boolean {
  return /\.(?:c|m)?js$/i.test(options.args[0] ?? '') && !options.args[0].startsWith('-')
}

export function spawnClaudeProcess(options: SpawnOptions, execArgv = process.execArgv): ChildProcess {
  const shared = { cwd: options.cwd, env: options.env, signal: options.signal, windowsHide: true }
  if (isClaudeJavaScriptProcess(options)) {
    return fork(options.args[0], options.args.slice(1), { ...shared, execArgv, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  }
  // SDK 0.3+ passes the native executable in command and CLI flags in args.
  return spawn(options.command, options.args, { ...shared, stdio: ['pipe', 'pipe', 'pipe'] })
}
