/**
 * BuiltinAgentProvisioner
 *
 * Provisions built-in agent workspaces by copying template files
 * (agent.json, .claude/skills/, .claude/plugins.json) from bundled
 * resources into the agent's working directory.
 *
 * The Claude Agent SDK auto-discovers skills from .claude/skills/ and
 * plugins from .claude/plugins.json, so no programmatic injection is needed.
 */
import { loggerService } from '@logger'
import { configManager } from '@main/services/ConfigManager'
import { getResourcePath } from '@main/utils'
import fs from 'fs'
import path from 'path'

const logger = loggerService.withContext('BuiltinAgentProvisioner')

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

export interface BuiltinAgentConfig {
  name?: string
  description?: string
  instructions?: string
  configuration?: Record<string, unknown>
}

/**
 * Provision a built-in agent's workspace with template files.
 *
 * Writes .claude/skills/ and .claude/plugins.json to the agent's
 * working directory so the SDK can auto-discover them.
 *
 * @param workspacePath - The agent's working directory (accessible_paths[0])
 * @param builtinRole - The built-in role identifier ('assistant' or 'skill-creator')
 * @returns The parsed agent.json config, or undefined if not found
 */
export async function provisionBuiltinAgent(
  workspacePath: string,
  builtinRole: string
): Promise<BuiltinAgentConfig | undefined> {
  const templateConfig = ROLE_TO_TEMPLATE[builtinRole]
  if (!templateConfig) {
    logger.warn('Unknown builtin role, skipping provisioning', { builtinRole })
    return undefined
  }

  const resourceBase = path.join(getResourcePath(), 'builtin-agents')
  const workspaceTemplateDir = path.join(resourceBase, templateConfig.workspaceTemplate)
  const configTemplateDir = path.join(resourceBase, templateConfig.configTemplate)

  if (!fs.existsSync(workspaceTemplateDir)) {
    logger.error('Builtin agent workspace template not found', { workspaceTemplateDir, builtinRole })
    return undefined
  }

  if (!fs.existsSync(configTemplateDir)) {
    logger.error('Builtin agent config template not found', { configTemplateDir, builtinRole })
    return undefined
  }

  try {
    // Copy .claude/ directory (skills + plugins.json)
    const srcClaudeDir = path.join(workspaceTemplateDir, '.claude')
    const destClaudeDir = path.join(workspacePath, '.claude')

    if (fs.existsSync(srcClaudeDir)) {
      copyDirSync(srcClaudeDir, destClaudeDir)
      if (builtinRole === 'fusion') {
        removeDirIfExists(path.join(destClaudeDir, 'skills'))
      }
      logger.info('Provisioned .claude/ directory for builtin agent', {
        builtinRole,
        workspacePath,
        destClaudeDir
      })
    }

    // Read agent.json to extract full config
    const agentJsonPath = path.join(configTemplateDir, 'agent.json')
    if (fs.existsSync(agentJsonPath)) {
      const agentConfig = JSON.parse(fs.readFileSync(agentJsonPath, 'utf-8'))
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
 * Check if a workspace has already been provisioned (has .claude/skills/).
 */
export function isProvisioned(workspacePath: string): boolean {
  return fs.existsSync(path.join(workspacePath, '.claude', 'skills'))
}
