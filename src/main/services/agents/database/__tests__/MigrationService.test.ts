import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { describe, expect, it, vi } from 'vitest'

vi.unmock('fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.mock('@main/utils', () => ({ getResourcePath: () => path.resolve('resources') }))

import { MigrationService } from '../MigrationService'
import * as schema from '../schema'

describe('Assistant SQLite schema migrations', () => {
  it('upgrades an existing database, preserves orphan history, and cascades valid parent deletes', async () => {
    const client = createClient({ url: ':memory:' })
    try {
      await client.execute('PRAGMA foreign_keys = OFF')
      const directory = path.resolve('resources/database/drizzle')
      const { entries } = JSON.parse(await readFile(path.join(directory, 'meta/_journal.json'), 'utf8'))
      for (const entry of entries.slice(0, 11)) {
        await client.executeMultiple(await readFile(path.join(directory, entry.tag + '.sql'), 'utf8'))
        await client.execute({ sql: 'INSERT INTO migrations VALUES (?, ?, 0)', args: [entry.idx, entry.tag] })
      }
      await client.execute(
        "INSERT INTO agents (id, type, name, model, created_at, updated_at) VALUES ('agent', 'claude-code', 'fixture', 'model', 'created', 'updated')"
      )
      await client.execute(
        "INSERT INTO sessions (id, agent_id, agent_type, name, model, created_at, updated_at) VALUES ('session', 'agent', 'claude-code', 'fixture', 'model', 'created', 'updated')"
      )
      await client.execute(
        "INSERT INTO session_messages (session_id, role, content, created_at, updated_at) VALUES ('session', 'user', '{}', 'created', 'updated'), ('old-orphan', 'user', '{}', 'created', 'updated')"
      )
      await client.execute(
        "INSERT INTO scheduled_tasks (id, agent_id, name, prompt, schedule_type, schedule_value, created_at, updated_at) VALUES ('task', 'agent', 'fixture', 'fixture', 'once', 'fixture', 'created', 'updated')"
      )
      await client.execute(
        "INSERT INTO task_run_logs (task_id, run_at, duration_ms, status) VALUES ('task', 'created', 0, 'success')"
      )

      const migration = new MigrationService(drizzle(client, { schema }), client)
      await migration.runMigrations()
      await migration.runMigrations()
      await client.execute('PRAGMA foreign_keys = ON')
      await client.execute("DELETE FROM agents WHERE id = 'agent'")
      expect((await client.execute('SELECT id FROM sessions')).rows).toEqual([])
      expect((await client.execute('SELECT id FROM scheduled_tasks')).rows).toEqual([])
      expect((await client.execute('SELECT id FROM task_run_logs')).rows).toEqual([])
      expect((await client.execute('SELECT session_id FROM session_messages')).rows).toEqual([
        { session_id: 'old-orphan' }
      ])
      await expect(
        client.execute(
          "INSERT INTO session_messages (session_id, role, content, created_at, updated_at) VALUES ('missing', 'user', '{}', 'created', 'updated')"
        )
      ).rejects.toThrow(/foreign key/i)
    } finally {
      client.close()
    }
  })

  it('rolls back schema changes when the migration record cannot be saved', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'zen-migration-test-'))
    const client = createClient({ url: ':memory:' })
    try {
      await mkdir(path.join(directory, 'meta'))
      await writeFile(
        path.join(directory, 'meta/_journal.json'),
        JSON.stringify({ entries: [{ idx: 0, tag: 'fixture' }] })
      )
      await writeFile(path.join(directory, 'fixture.sql'), 'CREATE TABLE fixture (id INTEGER);')
      await client.execute(
        'CREATE TABLE migrations (version integer CHECK(version > 0), tag text, executed_at integer)'
      )
      const migration = new MigrationService(drizzle(client, { schema }), client)
      Object.assign(migration, { migrationDir: directory })
      await expect(migration.runMigrations()).rejects.toThrow()
      expect((await client.execute("SELECT name FROM sqlite_master WHERE name = 'fixture'")).rows).toEqual([])
      expect((await client.execute('SELECT version FROM migrations')).rows).toEqual([])
    } finally {
      client.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
