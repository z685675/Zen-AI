import fs from 'node:fs/promises'
import path from 'node:path'

import type { InstalledSkill, SkillCompatibilityReport } from '@types'

import { readSkillFrontmatter } from './skillFrontmatter'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length <= 200).slice(0, 30)
    : []

export async function readSkillDeclaration(directory: string) {
  const file = path.join(directory, 'SKILL.md')
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('SKILL.md must be a regular file under 256 KiB')
  const source = await fs.readFile(file, 'utf8')
  const parsed = readSkillFrontmatter(source)
  const data = record(parsed.data)
  if (typeof data.name !== 'string' || !data.name.trim() || !parsed.content.trim())
    throw new Error('A native Skill requires a nonempty name and instructions')
  if (data.description !== undefined && typeof data.description !== 'string')
    throw new Error('Skill description must be text')
  const metadata = record(data.metadata)
  const requires = record(metadata.requires ?? record(metadata.openclaw).requires ?? record(metadata.clawdbot).requires)
  return {
    name: data.name.trim(),
    compatibility: typeof data.compatibility === 'string' ? data.compatibility.slice(0, 2000) : null,
    tools:
      typeof data['allowed-tools'] === 'string'
        ? data['allowed-tools']
            .split(/[\s,]+/)
            .filter(Boolean)
            .slice(0, 30)
        : strings(data['allowed-tools']),
    commands: strings(requires.bins),
    anyCommands: strings(requires.anyBins),
    environment: strings(requires.env)
  }
}

async function commandInPath(command: string) {
  if (!/^[a-zA-Z0-9._+-]{1,80}$/.test(command)) return false
  const extensions = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const file = path.join(dir, command + extension)
      try {
        if ((await fs.stat(file)).isFile()) {
          await fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
          return true
        }
      } catch {
        /* Only inspect file existence/permission, never execute imported commands. */
      }
    }
  }
  return false
}

export async function inspectSkillCompatibility(
  skill: InstalledSkill,
  installed: InstalledSkill[],
  globalRoot: string,
  builtinRoot: string
): Promise<SkillCompatibilityReport> {
  const report: SkillCompatibilityReport = {
    name: skill.name,
    enabled: skill.isEnabled,
    definitionValid: false,
    compatibility: null,
    declaredTools: [],
    requiredCommands: [],
    missingCommands: [],
    alternativeCommands: [],
    alternativesAvailable: null,
    requiredEnvironment: [],
    missingEnvironment: [],
    conflicts: [],
    warnings: []
  }
  try {
    const declaration = await readSkillDeclaration(path.join(globalRoot, skill.folderName))
    report.name = declaration.name
    report.definitionValid = true
    report.compatibility = declaration.compatibility
    report.declaredTools = declaration.tools
    report.requiredCommands = declaration.commands
    report.alternativeCommands = declaration.anyCommands
    report.requiredEnvironment = declaration.environment
    report.missingCommands = (
      await Promise.all(declaration.commands.map(async (command) => ((await commandInPath(command)) ? null : command)))
    ).filter((item): item is string => item !== null)
    if (declaration.anyCommands.length)
      report.alternativesAvailable = (await Promise.all(declaration.anyCommands.map(commandInPath))).some(Boolean)
    report.missingEnvironment = declaration.environment.filter((key) => !/^[\w]{1,100}$/.test(key) || !process.env[key])
    for (const other of installed.filter((item) => item.id !== skill.id && item.isEnabled)) {
      const name = (await readSkillDeclaration(path.join(globalRoot, other.folderName)).catch(() => undefined))?.name
      if (name === report.name) report.conflicts.push({ name, source: other.source, folder: other.folderName })
    }
    const folders = await fs.readdir(builtinRoot, { withFileTypes: true }).catch(() => [])
    for (const folder of folders.slice(0, 80)) {
      if (!folder.isDirectory() || folder.isSymbolicLink()) continue
      const name = (await readSkillDeclaration(path.join(builtinRoot, folder.name)).catch(() => undefined))?.name
      if (name === report.name && skill.source !== 'builtin')
        report.conflicts.push({ name, source: 'builtin', folder: folder.name })
    }
  } catch {
    report.warnings.push('definition-unreadable-or-invalid')
  }
  return report
}
