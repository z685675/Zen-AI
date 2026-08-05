import * as fs from 'node:fs'
import * as path from 'node:path'

import { loggerService } from '@logger'
import { getDataPath } from '@main/utils'

import { DatabaseManager } from '../database/DatabaseManager'
import { skillsTable } from '../database/schema'

const logger = loggerService.withContext('SkillWorkspaceSync')

/**
 * Mount enabled user Skills into a concrete agent workspace for both runtime
 * conventions. Existing real directories are intentionally left untouched.
 */
export async function syncSkillsToWorkspace(workspacePath: string): Promise<void> {
  try {
    await syncSkillsToWorkspaceInternal(workspacePath)
  } catch (error) {
    // Skills are optional runtime enhancements. A database or filesystem
    // problem must not prevent the selected agent runtime from starting.
    logger.warn('Failed to synchronize user Skills into agent workspace', {
      workspacePath,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function syncSkillsToWorkspaceInternal(workspacePath: string): Promise<void> {
  const databaseManager = await DatabaseManager.getInstance()
  const rows = await databaseManager
    .getDatabase()
    .select({ folderName: skillsTable.folder_name, isEnabled: skillsTable.is_enabled })
    .from(skillsTable)
  const globalSkillsPath = getDataPath('Skills')
  const skillByFolder = new Map(rows.map((skill) => [skill.folderName, skill]))

  for (const skill of rows) {
    for (const runtimeRoot of ['.claude', '.agents']) {
      const linkPath = path.join(workspacePath, runtimeRoot, 'skills', skill.folderName)
      if (skill.isEnabled) {
        await fs.promises.mkdir(path.dirname(linkPath), { recursive: true })
        try {
          const stat = await fs.promises.lstat(linkPath)
          if (stat.isSymbolicLink()) {
            const currentTarget = await fs.promises.readlink(linkPath)
            if (currentTarget === path.join(globalSkillsPath, skill.folderName)) continue
            await fs.promises.rm(linkPath, { recursive: true, force: true })
          } else {
            continue
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await fs.promises.symlink(path.join(globalSkillsPath, skill.folderName), linkPath, 'junction')
      } else {
        await removeSymlinkOnly(linkPath)
      }
    }
  }

  // Remove stale links that point into the global Skill store, but never touch
  // real local directories or links owned by another application.
  for (const runtimeRoot of ['.claude', '.agents']) {
    const skillsDir = path.join(workspacePath, runtimeRoot, 'skills')
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.promises.readdir(skillsDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      continue
    }

    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue
      const linkPath = path.join(skillsDir, entry.name)
      const target = await fs.promises.readlink(linkPath).catch(() => null)
      if (!target || !isInside(target, globalSkillsPath)) continue
      if (!skillByFolder.get(entry.name)?.isEnabled) {
        await fs.promises.rm(linkPath, { recursive: true, force: true })
      }
    }
  }

  logger.debug('Synchronized user Skills into agent workspace', { workspacePath, skillCount: rows.length })
}

async function removeSymlinkOnly(linkPath: string): Promise<void> {
  try {
    const stat = await fs.promises.lstat(linkPath)
    if (stat.isSymbolicLink()) await fs.promises.rm(linkPath, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function isInside(candidate: string, parent: string): boolean {
  const resolvedCandidate = path.resolve(candidate)
  const resolvedParent = path.resolve(parent)
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`)
}
