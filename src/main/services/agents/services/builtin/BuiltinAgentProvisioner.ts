/**
 * BuiltinAgentProvisioner
 *
 * Provisions built-in agent workspaces by copying template files
 * (agent.json, .claude/skills/, .agents/skills/, .claude/plugins.json) from bundled
 * resources into the agent's working directory.
 *
 * The Claude Agent SDK auto-discovers skills from .claude/skills/ and
 * plugins from .claude/plugins.json. Codex discovers skills from .agents/skills/.
 */
import { createHash, type Hash } from 'node:crypto'

import { loggerService } from '@logger'
import { configManager } from '@main/services/ConfigManager'
import { getResourcePath, toAsarUnpackedPath } from '@main/utils'
import fs from 'fs'
import path from 'path'

const logger = loggerService.withContext('BuiltinAgentProvisioner')
const RUNTIME_SKILL_DIRS = [
  ['.claude', 'skills'],
  ['.agents', 'skills']
] as const
// Bump this whenever the shape of a provisioned workspace changes. Existing
// workspaces will be checked and repaired on the next runtime invocation.
const PROVISION_MANIFEST_VERSION = 2
const PROVISION_MANIFEST_NAME = '.zen-ai-provision.json'
const SKILL_DEFINITION_FILES = ['SKILL.md', 'skill.md'] as const

interface ProvisionManifest {
  version: number
  builtinRole: string
  sourceFingerprint: string
}

/** Resolve a localized field: string passes through; locale-keyed object resolves by current language. */
function resolveLocalizedField(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return undefined

  const map = value as Record<string, string>
  const lang = configManager.getLanguage()
  const prefix = lang.split('-')[0]
  const prefixKey = Object.keys(map).find((k) => k.startsWith(prefix))

  return map[lang] || (prefixKey && map[prefixKey]) || map['en-US'] || Object.values(map)[0]
}

const ROLE_TO_TEMPLATE: Record<string, { workspaceTemplate: string; configTemplate: string }> = {
  assistant: {
    workspaceTemplate: 'cherry-assistant',
    configTemplate: 'cherry-assistant'
  },
  fusion: {
    workspaceTemplate: 'cherry-assistant',
    configTemplate: 'cherry-fusion'
  },
  'skill-creator': {
    workspaceTemplate: 'skill-creator',
    configTemplate: 'skill-creator'
  }
}

function getTemplateDirs(builtinRole: string):
  | {
      workspaceTemplateDir: string
      configTemplateDir: string
    }
  | undefined {
  const templateConfig = ROLE_TO_TEMPLATE[builtinRole]
  if (!templateConfig) {
    logger.warn('Unknown builtin role, skipping provisioning', { builtinRole })
    return undefined
  }

  const resourceBase = path.join(getResourcePath(), 'builtin-agents')
  const workspaceTemplateDir = path.join(resourceBase, templateConfig.workspaceTemplate)
  const configTemplateDir = path.join(resourceBase, templateConfig.configTemplate)

  if (!fs.existsSync(configTemplateDir)) {
    logger.error('Builtin agent config template not found', { configTemplateDir, builtinRole })
    return undefined
  }

  return { workspaceTemplateDir, configTemplateDir }
}

function hashSourcePath(hash: Hash, sourcePath: string, label: string): void {
  hash.update(`${label}\0`)
  if (!fs.existsSync(sourcePath)) {
    hash.update('missing\0')
    return
  }

  const stat = fs.statSync(sourcePath)
  if (stat.isFile()) {
    hash.update('file\0')
    hash.update(fs.readFileSync(sourcePath))
    return
  }

  const visitDirectory = (directory: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = path.join(directory, entry.name)
      const relativePath = path.relative(sourcePath, entryPath).split(path.sep).join('/')
      hash.update(`${entry.isDirectory() ? 'dir' : 'file'}:${relativePath}\0`)
      if (entry.isDirectory()) visitDirectory(entryPath)
      else if (entry.isFile()) hash.update(fs.readFileSync(entryPath))
    }
  }

  visitDirectory(sourcePath)
}

function calculateSourceFingerprint(builtinRole: string): string | undefined {
  const templateDirs = getTemplateDirs(builtinRole)
  if (!templateDirs) return undefined

  const agentJsonPath = path.join(templateDirs.configTemplateDir, 'agent.json')
  const sourceClaudeDir = path.join(templateDirs.workspaceTemplateDir, '.claude')
  if (!fs.existsSync(agentJsonPath) || !fs.existsSync(sourceClaudeDir)) return undefined

  const hash = createHash('sha256')
  hashSourcePath(hash, agentJsonPath, 'agent.json')

  if (builtinRole === 'fusion') {
    hashSourcePath(hash, path.join(sourceClaudeDir, 'plugins.json'), '.claude/plugins.json')
    const rawAgentConfig = JSON.parse(fs.readFileSync(agentJsonPath, 'utf-8'))
    const skillNames = getBuiltinSkillNames(rawAgentConfig?.skills).sort()
    hash.update(`skills:${skillNames.join(',')}\0`)
    const resourceSkillsDir = toAsarUnpackedPath(path.join(getResourcePath(), 'skills'))
    for (const skillName of skillNames) {
      hashSourcePath(hash, path.join(resourceSkillsDir, skillName), `skills/${skillName}`)
    }
  } else {
    hashSourcePath(hash, sourceClaudeDir, '.claude')
  }

  return hash.digest('hex')
}

function getProvisionManifestPath(workspacePath: string): string {
  return path.join(workspacePath, '.claude', PROVISION_MANIFEST_NAME)
}

function readProvisionManifest(workspacePath: string): ProvisionManifest | undefined {
  try {
    const manifestPath = getProvisionManifestPath(workspacePath)
    if (!fs.existsSync(manifestPath)) return undefined
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Partial<ProvisionManifest>
    if (
      parsed.version !== PROVISION_MANIFEST_VERSION ||
      typeof parsed.builtinRole !== 'string' ||
      typeof parsed.sourceFingerprint !== 'string'
    ) {
      return undefined
    }
    return parsed as ProvisionManifest
  } catch (error) {
    logger.warn('Failed to read builtin agent provision manifest', {
      workspacePath,
      error: error instanceof Error ? error.message : String(error)
    })
    return undefined
  }
}

function writeProvisionManifest(workspacePath: string, builtinRole: string, sourceFingerprint: string): void {
  const manifestPath = getProvisionManifestPath(workspacePath)
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        version: PROVISION_MANIFEST_VERSION,
        builtinRole,
        sourceFingerprint
      } satisfies ProvisionManifest,
      null,
      2
    )}\n`,
    'utf-8'
  )
}

/**
 * Recursively copy a directory, creating target dirs as needed.
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function removeDirIfExists(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true })
  }
}

function getBuiltinSkillNames(skillNames: unknown): string[] {
  if (!Array.isArray(skillNames) || skillNames.length === 0) return []

  const validNames: string[] = []
  for (const rawName of skillNames) {
    if (typeof rawName !== 'string' || !/^[a-z0-9-]+$/.test(rawName)) {
      logger.warn('Skipping invalid builtin skill name', { rawName })
      continue
    }
    validNames.push(rawName)
  }

  return validNames
}

function hasSkillDefinition(skillDir: string): boolean {
  return SKILL_DEFINITION_FILES.some((fileName) => fs.existsSync(path.join(skillDir, fileName)))
}

function getRequiredBuiltinSkillNames(builtinRole: string): string[] {
  return getBuiltinSkillNames(readBuiltinAgentJson(builtinRole)?.skills)
}

function hasCompleteRuntimeSkills(workspacePath: string, builtinRole: string): boolean {
  const requiredSkillNames = getRequiredBuiltinSkillNames(builtinRole)
  if (requiredSkillNames.length === 0) return true

  return RUNTIME_SKILL_DIRS.every(([root, skills]) => {
    const skillsDir = path.join(workspacePath, root, skills)
    return requiredSkillNames.every((skillName) => hasSkillDefinition(path.join(skillsDir, skillName)))
  })
}

function hasCompleteBundledSkills(builtinRole: string): boolean {
  if (builtinRole !== 'fusion') return true

  const resourceSkillsDir = toAsarUnpackedPath(path.join(getResourcePath(), 'skills'))
  return getRequiredBuiltinSkillNames(builtinRole).every((skillName) =>
    hasSkillDefinition(path.join(resourceSkillsDir, skillName))
  )
}

function copySelectedResourceSkills(skillNames: unknown, destSkillsDirs: string[]): void {
  const validNames = getBuiltinSkillNames(skillNames)
  if (validNames.length === 0) return

  const resourceSkillsDir = toAsarUnpackedPath(path.join(getResourcePath(), 'skills'))
  if (!fs.existsSync(resourceSkillsDir)) {
    logger.warn('Resource skills directory not found, skipping builtin skill provisioning', { resourceSkillsDir })
    return
  }

  for (const destSkillsDir of destSkillsDirs) {
    fs.mkdirSync(destSkillsDir, { recursive: true })
  }

  for (const skillName of validNames) {
    const sourceSkillDir = path.join(resourceSkillsDir, skillName)
    if (!fs.existsSync(sourceSkillDir) || !hasSkillDefinition(sourceSkillDir)) {
      logger.warn('Builtin skill declared by agent.json was not found in resources/skills', { skillName })
      continue
    }

    for (const destSkillsDir of destSkillsDirs) {
      const destSkillDir = path.join(destSkillsDir, skillName)
      removeDirIfExists(destSkillDir)
      copyDirSync(sourceSkillDir, destSkillDir)
    }
  }
}

function provisionCodexSkillMirror(workspacePath: string): void {
  const srcClaudeSkillsDir = path.join(workspacePath, '.claude', 'skills')
  const destAgentsSkillsDir = path.join(workspacePath, '.agents', 'skills')

  if (!fs.existsSync(srcClaudeSkillsDir)) {
    return
  }

  removeDirIfExists(destAgentsSkillsDir)
  copyDirSync(srcClaudeSkillsDir, destAgentsSkillsDir)
}

export function ensureBuiltinAgentRuntimeSkillRoots(workspacePath: string): boolean {
  const srcClaudeSkillsDir = path.join(workspacePath, '.claude', 'skills')
  const destAgentsSkillsDir = path.join(workspacePath, '.agents', 'skills')

  if (!fs.existsSync(srcClaudeSkillsDir) || fs.existsSync(destAgentsSkillsDir)) {
    return false
  }

  copyDirSync(srcClaudeSkillsDir, destAgentsSkillsDir)
  logger.info('Mirrored builtin agent skills into Codex skill root', {
    workspacePath,
    srcClaudeSkillsDir,
    destAgentsSkillsDir
  })
  return true
}

export interface BuiltinAgentConfig {
  name?: string
  description?: string
  instructions?: string
  configuration?: Record<string, unknown>
}

function toBuiltinAgentConfig(agentConfig: any): BuiltinAgentConfig | undefined {
  if (!agentConfig) {
    return undefined
  }

  return {
    name: agentConfig.name,
    description: resolveLocalizedField(agentConfig.description),
    instructions: resolveLocalizedField(agentConfig.instructions),
    configuration: agentConfig.configuration
  } as BuiltinAgentConfig
}

function readBuiltinAgentJson(builtinRole: string): any | undefined {
  const templateDirs = getTemplateDirs(builtinRole)
  if (!templateDirs) {
    return undefined
  }

  try {
    const agentJsonPath = path.join(templateDirs.configTemplateDir, 'agent.json')
    return fs.existsSync(agentJsonPath) ? JSON.parse(fs.readFileSync(agentJsonPath, 'utf-8')) : undefined
  } catch (error) {
    logger.error('Failed to read builtin agent config', {
      builtinRole,
      error: error instanceof Error ? error.message : String(error)
    })
    return undefined
  }
}

export function readBuiltinAgentConfig(builtinRole: string): BuiltinAgentConfig | undefined {
  return toBuiltinAgentConfig(readBuiltinAgentJson(builtinRole))
}

/**
 * Provision a built-in agent's workspace with template files.
 *
 * Writes .claude/skills/, .agents/skills/, and .claude/plugins.json to the agent's
 * working directory so the active runtime can auto-discover them.
 *
 * @param workspacePath - The agent's working directory (accessible_paths[0])
 * @param builtinRole - The built-in role identifier ('assistant' or 'skill-creator')
 * @returns The parsed agent.json config, or undefined if not found
 */
export async function provisionBuiltinAgent(
  workspacePath: string,
  builtinRole: string
): Promise<BuiltinAgentConfig | undefined> {
  const templateDirs = getTemplateDirs(builtinRole)
  if (!templateDirs) {
    return undefined
  }

  if (!fs.existsSync(templateDirs.workspaceTemplateDir)) {
    logger.error('Builtin agent workspace template not found', {
      workspaceTemplateDir: templateDirs.workspaceTemplateDir,
      builtinRole
    })
    return undefined
  }

  try {
    const rawAgentConfig = readBuiltinAgentJson(builtinRole)
    const agentConfig = toBuiltinAgentConfig(rawAgentConfig)
    const sourceFingerprint = calculateSourceFingerprint(builtinRole)

    // Copy .claude/ directory (skills + plugins.json)
    const srcClaudeDir = path.join(templateDirs.workspaceTemplateDir, '.claude')
    const destClaudeDir = path.join(workspacePath, '.claude')
    const destSkillDirs = RUNTIME_SKILL_DIRS.map(([root, skills]) => path.join(workspacePath, root, skills))

    if (fs.existsSync(srcClaudeDir)) {
      copyDirSync(srcClaudeDir, destClaudeDir)
      if (builtinRole === 'fusion') {
        for (const destSkillDir of destSkillDirs) {
          removeDirIfExists(destSkillDir)
        }
        copySelectedResourceSkills(rawAgentConfig?.skills, destSkillDirs)
      } else {
        provisionCodexSkillMirror(workspacePath)
      }
      logger.info('Provisioned builtin agent runtime directories', {
        builtinRole,
        workspacePath,
        destClaudeDir,
        destAgentsSkillsDir: path.join(workspacePath, '.agents', 'skills')
      })
      if (sourceFingerprint) writeProvisionManifest(workspacePath, builtinRole, sourceFingerprint)
    }

    // Read agent.json to extract full config
    if (agentConfig) {
      return {
        name: agentConfig.name,
        description: resolveLocalizedField(agentConfig.description),
        instructions: resolveLocalizedField(agentConfig.instructions),
        configuration: agentConfig.configuration
      } as BuiltinAgentConfig
    }

    return undefined
  } catch (error) {
    logger.error('Failed to provision builtin agent workspace', {
      builtinRole,
      workspacePath,
      error: error instanceof Error ? error.message : String(error)
    })
    return undefined
  }
}

/**
 * Check whether both runtime roots match the current bundled source content.
 */
export function isProvisioned(workspacePath: string, builtinRole: string): boolean {
  const hasRuntimeRoots = RUNTIME_SKILL_DIRS.every(([root, skills]) =>
    fs.existsSync(path.join(workspacePath, root, skills))
  )
  if (!hasRuntimeRoots) return false
  if (!hasCompleteBundledSkills(builtinRole) || !hasCompleteRuntimeSkills(workspacePath, builtinRole)) return false

  const sourceFingerprint = calculateSourceFingerprint(builtinRole)
  const manifest = readProvisionManifest(workspacePath)
  return Boolean(
    sourceFingerprint && manifest?.builtinRole === builtinRole && manifest.sourceFingerprint === sourceFingerprint
  )
}
