import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const apiKey = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY
const baseUrl = process.env.OPENAI_BASE_URL
const model = process.env.CODEX_SMOKE_MODEL
const keepWorkspace = process.env.CODEX_SMOKE_KEEP === '1'
const timeoutMs = Number(process.env.CODEX_SMOKE_TIMEOUT_MS || 120_000)

const resultFile = 'codex-smoke-result.md'

type SmokeThreadEvent =
  | { type: 'item.completed'; item: { type: string; text?: string } }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'error'; message: string }
  | { type: string; [key: string]: unknown }

type AgentMessageCompletedEvent = { type: 'item.completed'; item: { type: 'agent_message'; text: string } }
type CodexFailureEvent = Extract<SmokeThreadEvent, { type: 'turn.failed' | 'error' }>

type CodexConstructor = new (
  options?: unknown
) => {
  startThread(options?: unknown): {
    id: string | null
    runStreamed(
      input: unknown,
      turnOptions?: { signal?: AbortSignal }
    ): Promise<{
      events: AsyncGenerator<SmokeThreadEvent>
    }>
  }
}

async function main() {
  if (!apiKey) {
    console.log('SKIP codex smoke: set CODEX_API_KEY or OPENAI_API_KEY to run the live Codex CLI check.')
    return
  }

  const workspace = await mkdtemp(path.join(os.tmpdir(), 'Zen AI Codex Smoke 中文 路径 '))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    await mkdir(path.join(workspace, '.agents', 'skills', 'zen-smoke-skill'), { recursive: true })
    await writeFile(
      path.join(workspace, '.agents', 'skills', 'zen-smoke-skill', 'SKILL.md'),
      [
        '---',
        'name: zen-smoke-skill',
        'description: Use for Zen AI Codex runtime smoke tests that need to create a small Markdown file.',
        '---',
        '',
        '# Zen Smoke Skill',
        '',
        `Create ${resultFile} in the current workspace when asked to run the smoke test.`
      ].join('\n'),
      'utf8'
    )

    const Codex = await loadCodexConstructor()
    const codex = new Codex({
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      config: {
        show_raw_agent_reasoning: true,
        sandbox_workspace_write: {
          network_access: true
        }
      }
    })

    const thread = codex.startThread({
      ...(model ? { model } : {}),
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
      webSearchMode: 'disabled'
    })

    const prompt = [
      `Create a Markdown file named ${resultFile} in the current workspace.`,
      'The file must contain exactly these three lines:',
      '# Codex Smoke OK',
      '- runtime: codex',
      '- skill-root: .agents/skills',
      'Do not create any other files.'
    ].join('\n')

    const { events } = await thread.runStreamed(prompt, { signal: controller.signal })
    let finalText = ''
    let eventCount = 0

    for await (const event of events) {
      eventCount += 1
      if (isAgentMessageCompleted(event)) {
        finalText = event.item.text
      }
      if (isCodexFailureEvent(event)) {
        throw new Error(`Codex smoke failed: ${formatCodexError(event)}`)
      }
    }

    const outputPath = path.join(workspace, resultFile)
    await access(outputPath)
    const output = await readFile(outputPath, 'utf8')
    if (!output.includes('# Codex Smoke OK') || !output.includes('runtime: codex')) {
      throw new Error(`Codex smoke file content did not match expectations:\n${output}`)
    }

    console.log('PASS codex smoke')
    console.log(`workspace=${workspace}`)
    console.log(`thread=${thread.id ?? 'unknown'}`)
    console.log(`events=${eventCount}`)
    if (finalText.trim()) {
      console.log(`final=${finalText.trim().slice(0, 300)}`)
    }

    if (!keepWorkspace) {
      await rm(workspace, { recursive: true, force: true })
    }
  } catch (error) {
    console.error('FAIL codex smoke')
    console.error(`workspace=${workspace}`)
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
  }
}

async function loadCodexConstructor(): Promise<CodexConstructor> {
  const mod = (await import('@openai/codex-sdk')) as { Codex?: CodexConstructor }
  if (!mod.Codex) {
    throw new Error('Codex SDK did not export Codex')
  }
  return mod.Codex
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function isAgentMessageCompleted(event: SmokeThreadEvent): event is AgentMessageCompletedEvent {
  if (event.type !== 'item.completed' || !isRecord(event.item)) {
    return false
  }

  return event.item.type === 'agent_message' && typeof event.item.text === 'string'
}

function isCodexFailureEvent(event: SmokeThreadEvent): event is CodexFailureEvent {
  if (event.type === 'turn.failed') {
    return isRecord(event.error) && typeof event.error.message === 'string'
  }

  return event.type === 'error' && typeof event.message === 'string'
}

function formatCodexError(event: CodexFailureEvent): string {
  if (event.type === 'turn.failed') {
    return event.error.message
  }
  return event.message
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
