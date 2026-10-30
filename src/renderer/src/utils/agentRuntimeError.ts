import type { SerializedError } from '@renderer/types/error'

export function isAgentRuntimeStartupError(error?: SerializedError): boolean {
  if ((error as { zenFailureStage?: string } | undefined)?.zenFailureStage === 'runtime-startup') return true
  const text = [error?.name, error?.message, error?.stack, error?.cause]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase()
  return [
    /native cli binary for .* not found/,
    /agent runtime executable not found/,
    /opencode (?:process exited during startup|startup timed out|process did not stop)/,
    /(?:cannot find module|missing optional dependency).*@(?:openai\/codex|anthropic-ai\/claude-agent-sdk)/,
    /(?:cannot|could not|unable to) (?:find|locate).*(?:codex|claude).*(?:binary|executable|cli)/,
    /spawn .*[/\\](?:claude|codex)(?:\.exe)? (?:enoent|eacces|enoexec)/,
    /(?:claude|codex).*(?:bad cpu type|exec format error)/
  ].some((pattern) => pattern.test(text))
}
