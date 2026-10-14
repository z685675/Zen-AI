import fs from 'node:fs/promises'
import path from 'node:path'

import { config as apiConfigService } from '@main/apiServer/config'
import { validateModelId } from '@main/apiServer/utils'
import { getDataPath, getResourcePath, toAsarUnpackedPath } from '@main/utils'
import type { GetAgentSessionResponse, Provider } from '@types'

import { SkillRepository } from '../../skills/SkillRepository'
import { buildOpenCodeConfig } from './config'
import { getOpenCodeProcess } from './process'

export async function prepareOpenCodeRuntime(
  session: GetAgentSessionResponse,
  signal: AbortSignal,
  options?: { provider?: Provider; modelId?: string; effort?: string; onStarting?: () => void; diagnosticId?: string }
) {
  const model = options?.provider ? options : await validateModelId(session.model)
  if (!model.provider || !model.modelId || !session.accessible_paths[0])
    throw new Error('New assistant model/workspace unavailable')
  const skills = await SkillRepository.getInstance().list()
  const skillPaths = skills
    .filter((skill) => skill.isEnabled)
    .map((skill) => path.join(getDataPath('Skills'), skill.folderName))
  const builtinRoot = path.join(session.accessible_paths[0], '.agents', 'skills')
  const builtinFolders = await fs.readdir(builtinRoot, { withFileTypes: true }).catch(() => [])
  for (const folder of builtinFolders) {
    if (folder.isDirectory() && !folder.isSymbolicLink()) skillPaths.unshift(path.join(builtinRoot, folder.name))
  }
  // A legacy/custom workspace may not contain the new builtin skill mirror.
  // Read the packaged definitions in place; do not overwrite the user's files.
  if (session.configuration?.legacy_continuation) {
    const resources = toAsarUnpackedPath(getResourcePath())
    const template = JSON.parse(
      await fs.readFile(path.join(resources, 'builtin-agents', 'cherry-fusion', 'agent.json'), 'utf8')
    )
    const mirrored = new Set(
      builtinFolders.filter((folder) => folder.isDirectory() && !folder.isSymbolicLink()).map((folder) => folder.name)
    )
    for (const name of Array.isArray(template.skills) ? template.skills : []) {
      if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name) || mirrored.has(name)) continue
      const folder = path.join(resources, 'skills', name)
      if (!(await fs.stat(path.join(folder, 'SKILL.md')).catch(() => undefined))?.isFile())
        throw new Error('Bundled assistant skill is missing; reinstall or repair the app')
      skillPaths.unshift(folder)
    }
  }
  const api = await apiConfigService.get()
  const config = buildOpenCodeConfig({
    session,
    provider: model.provider,
    modelId: model.modelId,
    skillPaths,
    api,
    effort: options?.effort
  })
  return getOpenCodeProcess(
    session.id,
    session.accessible_paths[0],
    config,
    [...session.accessible_paths, ...skillPaths],
    signal,
    options?.onStarting,
    options?.diagnosticId
  )
}
