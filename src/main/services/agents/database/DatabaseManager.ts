/**
 * @deprecated Scheduled for removal in v2.0.0
 * --------------------------------------------------------------------------
 * ⚠️ NOTICE: V2 DATA&UI REFACTORING (by 0xfullex)
 * --------------------------------------------------------------------------
 * STOP: Feature PRs affecting this file are currently BLOCKED.
 * Only critical bug fixes are accepted during this migration phase.
 *
 * This file is being refactored to v2 standards.
 * Any non-critical changes will conflict with the ongoing work.
 *
 * 🔗 Context & Status:
 * - Contribution Hold: https://github.com/CherryHQ/cherry-studio/issues/10954
 * - v2 Refactor PR   : https://github.com/CherryHQ/cherry-studio/pull/10162
 * --------------------------------------------------------------------------
 */
import { type Client, createClient } from '@libsql/client'
import { loggerService } from '@logger'
import { isDev } from '@main/constant'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import { drizzle } from 'drizzle-orm/libsql'
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

import { assertAssistantDataAvailable } from '../services/dataOperationGate'
import { DataMigrationService } from './DataMigrationService'
import { MigrationService } from './MigrationService'
import * as schema from './schema'

const dbPath = path.join(app.getPath('userData'), 'Data', 'agents.db')

function getOldDbPath() {
  return path.join(app.getPath('userData'), 'agents.db')
}

const logger = loggerService.withContext('DatabaseManager')

/**
 * Database initialization state
 */
enum InitState {
  INITIALIZING = 'initializing',
  INITIALIZED = 'initialized',
  FAILED = 'failed',
  CLOSED = 'closed'
}

/**
 * DatabaseManager - Singleton class for managing libsql database connections
 *
 * Responsibilities:
 * - Single source of truth for database connection
 * - Thread-safe initialization with state management
 * - Automatic migration handling
 * - Safe connection cleanup
 * - Error recovery and retry logic
 * - Windows platform compatibility fixes
 */
export class DatabaseManager {
  private static instance: DatabaseManager | null = null
  private static initializing: Promise<DatabaseManager> | null = null
  private static closing: Promise<void> | null = null
  private static shuttingDown = false
  // Keep a failed native handle alive and fail closed until the next app start.
  // It is not safe to retry closing/replacing its files or open another client.
  private static closeFailure: { error: unknown; client: Client } | null = null

  private client: Client | null = null
  private db: LibSQLDatabase<typeof schema> | null = null
  private state: InitState = InitState.INITIALIZING

  /**
   * Get the singleton instance (database initialization starts automatically)
   */
  public static async getInstance(): Promise<DatabaseManager> {
    DatabaseManager.assertAvailable()
    if (DatabaseManager.instance) {
      return DatabaseManager.instance
    }

    if (!DatabaseManager.initializing) {
      const instance = new DatabaseManager()
      // Publish the promise before migrations yield, not the partially initialized
      // client. Concurrent services must share one native connection/migration.
      const initializing = instance.initialize().then(() => {
        DatabaseManager.instance = instance
        return instance
      })
      DatabaseManager.initializing = initializing
      void initializing
        .finally(() => {
          if (DatabaseManager.initializing === initializing) DatabaseManager.initializing = null
        })
        .catch(() => {})
    }
    const instance = await DatabaseManager.initializing
    // A restore/quit may have started while migrations were running.
    DatabaseManager.assertAvailable()
    return instance
  }

  private static assertAvailable(): void {
    assertAssistantDataAvailable()
    if (DatabaseManager.closeFailure)
      throw Object.assign(new Error('Assistant database failed to close; restart the application before retrying'), {
        code: 'assistant_database_close_failed',
        cause: DatabaseManager.closeFailure.error
      })
    if (DatabaseManager.shuttingDown || DatabaseManager.closing)
      throw Object.assign(new Error('Assistant database is closing'), { code: 'assistant_database_closing' })
  }

  /**
   * Migrate agents.db from old path ({userData}/agents.db) to new path ({userData}/Data/agents.db).
   * Only moves when old path exists and new path does not. Also handles -wal and -shm auxiliary files.
   */
  private static migrateFromOldPath(): void {
    if (isDev) {
      return
    }

    const oldPath = getOldDbPath()
    if (!fs.existsSync(oldPath) || fs.existsSync(dbPath)) {
      return
    }

    const dbDir = path.dirname(dbPath)
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }

    logger.info(`Migrating agents.db from ${oldPath} to ${dbPath}`)
    fs.renameSync(oldPath, dbPath)

    // SQLite WAL mode auxiliary files: -wal (write-ahead log with uncommitted data) and -shm (shared memory index)
    for (const suffix of ['-wal', '-shm']) {
      const oldAux = oldPath + suffix
      if (fs.existsSync(oldAux)) {
        fs.renameSync(oldAux, dbPath + suffix)
      }
    }
  }

  /**
   * Perform the actual initialization
   */
  public async initialize(): Promise<void> {
    if (this.state === InitState.INITIALIZED) {
      return
    }

    try {
      DatabaseManager.migrateFromOldPath()

      logger.info(`Initializing database at: ${dbPath}`)

      // Ensure database directory exists
      const dbDir = path.dirname(dbPath)
      if (!fs.existsSync(dbDir)) {
        logger.info(`Creating database directory: ${dbDir}`)
        fs.mkdirSync(dbDir, { recursive: true })
      }

      // Check if database file is corrupted (Windows specific check)
      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath)
        if (stats.size === 0) {
          logger.warn('Database file is empty, removing corrupted file')
          fs.unlinkSync(dbPath)
        }
      }

      // Create client with platform-specific options
      this.client = createClient({
        url: `file:${dbPath}`,
        // intMode: 'number' helps avoid some Windows compatibility issues
        intMode: 'number'
      })

      // Create drizzle instance
      this.db = drizzle(this.client, { schema })

      // Run schema migrations
      const migrationService = new MigrationService(this.db, this.client)
      await migrationService.runMigrations()

      // Run data migrations (must run after schema migrations)
      const dataMigrationService = new DataMigrationService(this.db, this.client)
      await dataMigrationService.runDataMigrations()

      this.state = InitState.INITIALIZED
      logger.info('Database initialized successfully')
    } catch (error) {
      const err = error as Error
      logger.error('Database initialization failed:', {
        error: err.message,
        stack: err.stack
      })

      // Clean up failed initialization
      this.cleanupFailedInit()

      // Set failed state
      this.state = InitState.FAILED
      throw new Error(`Database initialization failed: ${err.message || 'Unknown error'}`)
    }
  }

  /**
   * Clean up after failed initialization
   */
  private cleanupFailedInit(): void {
    const client = this.client
    this.client = null
    this.db = null
    if (client) {
      try {
        client.close()
      } catch (error) {
        DatabaseManager.closeFailure = { error, client }
        logger.warn('Failed to close client during cleanup:', error as Error)
      }
    }
  }

  /**
   * Get the database instance
   * Automatically waits for initialization to complete
   * @throws Error if database initialization failed
   */
  public getDatabase(): LibSQLDatabase<typeof schema> {
    if (!this.isInitialized() || !this.db) throw new Error('Assistant database is not open')
    return this.db
  }

  /**
   * Get the raw client (for advanced operations)
   * Automatically waits for initialization to complete
   * @throws Error if database initialization failed
   */
  public async getClient(): Promise<Client> {
    if (!this.isInitialized() || !this.client) throw new Error('Assistant database is not open')
    return this.client
  }

  /**
   * Check if database is initialized
   */
  public isInitialized(): boolean {
    return this.state === InitState.INITIALIZED
  }

  /**
   * Close the database connection and reset the singleton.
   * Must be called before deleting agents.db (e.g. during backup restore).
   * After calling this, getInstance() will re-initialize a fresh connection.
   */
  public static async close(): Promise<void> {
    if (DatabaseManager.closing) return DatabaseManager.closing
    if (DatabaseManager.closeFailure) throw DatabaseManager.closeFailure.error
    const closing = DatabaseManager.closeCurrent()
    DatabaseManager.closing = closing
    try {
      await closing
    } finally {
      if (DatabaseManager.closing === closing) DatabaseManager.closing = null
    }
  }

  /** Close only an existing/in-flight connection; never initialize on quit. */
  public static async shutdown(): Promise<void> {
    DatabaseManager.shuttingDown = true
    await DatabaseManager.close()
  }

  private static async closeCurrent(): Promise<void> {
    // Do not let a late initialization publish an untracked native client after
    // restore or shutdown has already closed the singleton.
    if (DatabaseManager.initializing) {
      try {
        await DatabaseManager.initializing
      } catch {
        // initialize() already cleaned up its failed client and reported the error.
        if (DatabaseManager.closeFailure) throw DatabaseManager.closeFailure.error
        return
      }
    }
    const instance = DatabaseManager.instance
    if (!instance) {
      return
    }

    DatabaseManager.instance = null
    const client = instance.client
    instance.client = null
    instance.db = null
    instance.state = InitState.CLOSED
    if (client) {
      try {
        client.close()
        logger.info('Database connection closed')
      } catch (error) {
        DatabaseManager.closeFailure = { error, client }
        logger.warn('Failed to close database connection:', error as Error)
        // A restore must not replace files when the native connection failed to close.
        throw error
      }
    }
  }
}
