import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DiagnosticRecorder, type DiagnosticStage, sanitizeDiagnostic } from '@shared/diagnostics'
import { app } from 'electron'

const recorder = new DiagnosticRecorder()
const logs: Array<{ at: string; level: string; message: string; data: unknown }> = []
const validId = (id: string) => /^[\w.-]{1,128}$/.test(id)
const directory = () => path.join(app.getPath('userData'), 'logs', 'diagnostics')
const filePath = (id: string) => path.join(directory(), `diag-${id}.json`)

export function beginMainDiagnostic(id: string, metadata: Record<string, unknown>) {
  if (!validId(id)) return
  recorder.begin(id, metadata)
}

export function recordMainDiagnostic(
  id: string | undefined,
  stage: DiagnosticStage,
  event: string,
  details?: Record<string, unknown>
) {
  try {
    recorder.record(id, stage, event, details)
    if (id && validId(id) && (event === 'failed' || event === 'complete')) {
      fs.mkdirSync(directory(), { recursive: true })
      fs.writeFileSync(filePath(id), JSON.stringify(recorder.get(id)))
      // Only our explicitly named diagnostic snapshots are eligible for retention cleanup.
      const entries = fs
        .readdirSync(directory())
        .filter((name) => /^diag-[\w.-]+\.json$/.test(name))
        .map((name) => ({ name, time: fs.statSync(path.join(directory(), name)).mtimeMs }))
        .sort((a, b) => b.time - a.time)
      for (const entry of entries.slice(100)) fs.unlinkSync(path.join(directory(), entry.name))
    }
  } catch {
    /* Diagnostics must never fail the user's request. */
  }
}

export function captureDiagnosticLog(level: string, message: string, data: unknown) {
  try {
    logs.push({
      at: new Date().toISOString(),
      level,
      message: String(sanitizeDiagnostic(message)),
      data: sanitizeDiagnostic(data)
    })
    if (logs.length > 200) logs.shift()
  } catch {
    /* Best effort. */
  }
}

export async function collectMainDiagnostic(id: string) {
  if (!validId(id)) throw new Error('Invalid diagnostic operation ID')
  let evidence = recorder.get(id)
  let snapshotStatus = evidence ? 'collected' : 'unavailable'
  if (!evidence) {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath(id), 'utf8'))
      if (saved.operationId === id) {
        evidence = saved
        snapshotStatus = 'collected-from-disk'
      }
    } catch {
      /* Manifest reports unavailable. */
    }
  }
  const sessionId = evidence?.metadata.sessionId
  const relatedLogs = logs.filter((entry) => {
    if (evidence && (entry.at < evidence.startedAt || entry.at > evidence.updatedAt)) return false
    const text = JSON.stringify(entry)
    return text.includes(id) || (typeof sessionId === 'string' && text.includes(sessionId))
  })
  const componentVersions: Record<string, unknown> = {}
  for (const name of ['@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'node_modules', name, 'package.json'), 'utf8'))
      componentVersions[name] = pkg.version
    } catch {
      componentVersions[name] = 'unavailable'
    }
  }
  const executables: Record<string, unknown> = {}
  try {
    const { resolveCodexExecutable } = await import('./agents/services/codex/executable')
    const { resolveClaudeExecutablePath } = await import('./agents/services/claudecode/executable')
    for (const [name, executable] of Object.entries({
      codex: resolveCodexExecutable()?.executablePath,
      claude: resolveClaudeExecutablePath()
    })) {
      let executablePermission: boolean | string = process.platform === 'win32' ? 'not-applicable-on-windows' : false
      if (executable && process.platform !== 'win32') {
        try {
          fs.accessSync(executable, fs.constants.X_OK)
          executablePermission = true
        } catch {
          /* Not executable. */
        }
      }
      executables[name] = {
        path: executable,
        exists: executable ? fs.existsSync(executable) : false,
        executablePermission
      }
    }
  } catch {
    executables.collectionStatus = 'failed'
  }
  return {
    evidence,
    snapshotStatus,
    logs: relatedLogs.slice(-80),
    logStatus: relatedLogs.length ? 'collected-bounded-operation-logs' : 'unavailable-or-no-matching-logs',
    environment: {
      osType: os.type(),
      osRelease: os.release(),
      osVersion: os.version(),
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      componentVersions,
      packaged: app.isPackaged,
      appVersion: app.getVersion(),
      resourcesPath: process.resourcesPath,
      executables,
      snapshotTime: 'export-time'
    }
  }
}
