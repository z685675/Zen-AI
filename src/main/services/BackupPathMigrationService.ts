import { createClient } from '@libsql/client'
import { loggerService } from '@logger'
import { migrateInternalDataPathsInString } from '@shared/utils/internalDataPathMigration'
import { app } from 'electron'
import * as fs from 'fs-extra'
import * as path from 'path'

import { getDataPath } from '../utils'

const logger = loggerService.withContext('BackupPathMigrationService')

type TextColumnTarget = {
  table: string
  idColumn: string
  column: string
}

const AGENT_DB_TEXT_COLUMNS: TextColumnTarget[] = [
  { table: 'agents', idColumn: 'id', column: 'accessible_paths' },
  { table: 'sessions', idColumn: 'id', column: 'accessible_paths' },
  { table: 'session_messages', idColumn: 'id', column: 'content' },
  { table: 'session_messages', idColumn: 'id', column: 'metadata' },
  { table: 'scheduled_tasks', idColumn: 'id', column: 'prompt' },
  { table: 'scheduled_tasks', idColumn: 'id', column: 'last_result' },
  { table: 'task_run_logs', idColumn: 'id', column: 'result' },
  { table: 'task_run_logs', idColumn: 'id', column: 'error' }
]

const NOTE_EXTENSIONS = new Set(['.md', '.markdown'])

export class BackupPathMigrationService {
  static async migrateRestoredInternalPaths(): Promise<void> {
    const currentUserDataPath = app.getPath('userData')

    await Promise.all([
      this.migrateAgentsDatabase(currentUserDataPath),
      this.migrateNotesInternalLinks(currentUserDataPath)
    ])
  }

  private static async migrateAgentsDatabase(currentUserDataPath: string): Promise<void> {
    const dbPath = path.join(getDataPath(), 'agents.db')
    if (!(await fs.pathExists(dbPath))) {
      return
    }

    const client = createClient({ url: `file:${dbPath}` })
    let updated = 0

    try {
      for (const target of AGENT_DB_TEXT_COLUMNS) {
        if (!(await this.hasColumn(client, target.table, target.column))) {
          continue
        }

        const rows = await client.execute(
          `SELECT ${target.idColumn} AS id, ${target.column} AS value FROM ${target.table} WHERE ${target.column} IS NOT NULL`
        )

        for (const row of rows.rows) {
          const id = row.id
          const value = row.value
          if ((typeof id !== 'string' && typeof id !== 'number') || typeof value !== 'string') {
            continue
          }

          const result = migrateInternalDataPathsInString(value, currentUserDataPath)
          if (!result.changed) {
            continue
          }

          await client.execute({
            sql: `UPDATE ${target.table} SET ${target.column} = ? WHERE ${target.idColumn} = ?`,
            args: [result.value, id]
          })
          updated += 1
        }
      }

      if (updated > 0) {
        logger.info('Migrated internal data paths in agents database', { updated })
      }
    } catch (error) {
      logger.error('Failed to migrate internal data paths in agents database', error as Error)
    } finally {
      client.close()
    }
  }

  private static async hasColumn(
    client: ReturnType<typeof createClient>,
    table: string,
    column: string
  ): Promise<boolean> {
    try {
      const result = await client.execute(`PRAGMA table_info(${table})`)
      return result.rows.some((row) => row.name === column)
    } catch {
      return false
    }
  }

  private static async migrateNotesInternalLinks(currentUserDataPath: string): Promise<void> {
    const notesDir = path.join(getDataPath(), 'Notes')
    if (!(await fs.pathExists(notesDir))) {
      return
    }

    let updated = 0

    try {
      const files = await this.listNoteFiles(notesDir)
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8')
        const result = migrateInternalDataPathsInString(content, currentUserDataPath)
        if (!result.changed) {
          continue
        }

        await fs.writeFile(file, result.value, 'utf-8')
        updated += 1
      }

      if (updated > 0) {
        logger.info('Migrated internal data links in notes', { updated })
      }
    } catch (error) {
      logger.error('Failed to migrate internal data links in notes', error as Error)
    }
  }

  private static async listNoteFiles(root: string): Promise<string[]> {
    const files: string[] = []
    const entries = await fs.readdir(root, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        files.push(...(await this.listNoteFiles(fullPath)))
        continue
      }

      if (entry.isFile() && NOTE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath)
      }
    }

    return files
  }
}
