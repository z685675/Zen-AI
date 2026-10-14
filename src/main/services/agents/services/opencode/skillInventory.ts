import fs from 'node:fs/promises'
import path from 'node:path'

import { getDataPath } from '@main/utils'
import type { SessionSkillInventory } from '@shared/agents/skillInventory'
import type { GetAgentSessionResponse } from '@types'

import { readSkillFrontmatter } from '../../skills/skillFrontmatter'
import { SkillRepository } from '../../skills/SkillRepository'
import { inspectOpenCodeSkills } from './process'

const canonical = (file: string) =>
  process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)

export async function getSessionSkillInventory(session: GetAgentSessionResponse): Promise<SessionSkillInventory> {
  const [installed, native] = await Promise.all([
    SkillRepository.getInstance().list(),
    inspectOpenCodeSkills(session.id)
  ])
  const skills: SessionSkillInventory['skills'] = installed.slice(0, 1000).map((skill) => ({
    name: skill.name,
    path: path.join(getDataPath('Skills'), skill.folderName, 'SKILL.md'),
    source: 'installed',
    installed: true,
    enabled: skill.isEnabled && skill.name !== 'customize-opencode',
    discovered: null
  }))
  const root = path.join(session.accessible_paths[0], '.agents', 'skills')
  const folders = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const folder of folders.slice(0, 1000)) {
    if (!folder.isDirectory() || folder.isSymbolicLink()) continue
    const file = path.join(root, folder.name, 'SKILL.md')
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.size > 256 * 1024) continue
      const { data } = readSkillFrontmatter(await fs.readFile(file, 'utf8'))
      skills.push({
        name: typeof data.name === 'string' ? data.name : folder.name,
        path: file,
        source: 'workspace',
        installed: true,
        enabled: data.name !== 'customize-opencode',
        discovered: null
      })
    } catch {
      /* Missing or invalid definitions remain unconfirmed, not loaded. */
    }
  }
  const discovered = new Set(native.skills.map((skill) => canonical(skill.path)))
  for (const skill of skills) {
    skill.discovered = native.status === 'observed' ? discovered.has(canonical(skill.path)) : null
  }
  for (const skill of native.skills) {
    if (!skills.some((candidate) => canonical(candidate.path) === canonical(skill.path))) {
      skills.push({
        ...skill,
        source: 'native',
        installed: false,
        enabled: skill.name !== 'customize-opencode',
        discovered: true
      })
    }
  }
  return {
    observedAt: new Date().toISOString(),
    nativeStatus: native.status,
    refreshRequired: native.refreshRequired,
    skills
  }
}
