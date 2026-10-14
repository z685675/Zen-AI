import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import * as fs from 'fs-extra'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:fs')
vi.unmock('fs')
vi.unmock('fs-extra')
import { includeAssistantBackupPath, stageAssistantBackupData } from '../AssistantBackupSnapshot'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-assistant-backup-test-'))
})
afterEach(async () => {
  if (!root) return
  if (
    path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
    !path.basename(root).startsWith('zen-assistant-backup-test-')
  )
    throw new Error('Unsafe cleanup path')
  // Windows SQLite closes may finish asynchronously after client.close().
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.remove(root)
      break
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '') || attempt >= 19) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
})
describe('slim assistant data snapshots', () => {
  it('selects actual history and skills, not attachment files, runtime cache or archived copies', () => {
    const key = 'a'.repeat(64)
    for (const file of [
      '',
      'Skills/xlsx/SKILL.md',
      `OpenCode/${key}/binding.json`,
      `OpenCode/${key}/data/opencode/db.sqlite`
    ])
      expect(includeAssistantBackupPath(file, true)).toBe(true)
    for (const file of [
      'Files/image.png',
      'agents.db-wal',
      `OpenCode/${key}/cache/file`,
      `OpenCode/archived-${key}/data/db.sqlite`
    ])
      expect(includeAssistantBackupPath(file, true)).toBe(false)
  })
  it.each([true, false])(
    'takes a readable SQLite snapshot and preserves the native binding (slim=%s)',
    async (slim) => {
      const source = path.join(root, 'source')
      const target = path.join(root, 'snapshot')
      const key = 'b'.repeat(64)
      await fs.ensureDir(source)
      await fs.outputJson(path.join(source, 'OpenCode', key, 'binding.json'), { sessionId: 'kept-native' })
      await fs.outputFile(path.join(source, 'OpenCode', key, 'data', 'history.json'), 'native conversation')
      await fs.outputFile(path.join(source, 'Files', 'attachment.bin'), 'not included in slim')
      // Isolate native SQLite handles: some Windows libsql builds retain prepared
      // statement handles until GC even after close(). Child exit guarantees release.
      const helper = pathToFileURL(path.resolve('src/main/services/AssistantBackupSnapshot.ts')).href
      const script = `
      (async () => {
        const { createClient } = require('@libsql/client');
        const helper = await import(${JSON.stringify(helper)});
        const { copyAssistantBackupData } = helper.default || helper;
        const source = ${JSON.stringify(source)}, target = ${JSON.stringify(target)};
        const client = createClient({ url: 'file:' + require('node:path').join(source, 'agents.db') });
        try {
          await client.execute('CREATE TABLE history (text TEXT)');
          await client.execute("INSERT INTO history VALUES ('saved conversation')");
          await copyAssistantBackupData(source, target, ${slim});
        } finally { client.close(); }
        const snapshot = createClient({ url: 'file:' + require('node:path').join(target, 'agents.db') });
        try { process.stdout.write(JSON.stringify((await snapshot.execute('SELECT * FROM history')).rows)); }
        finally { snapshot.close(); }
      })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
    `
      const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '-e', script], { timeout: 10_000 })
      expect(JSON.parse(result.stdout)[0].text).toBe('saved conversation')
      expect(await fs.readJson(path.join(target, 'OpenCode', key, 'binding.json'))).toEqual({
        sessionId: 'kept-native'
      })
      expect(await fs.pathExists(path.join(target, 'Files', 'attachment.bin'))).toBe(!slim)
    },
    15_000
  )
  it('slim restore preserves omitted local files but replaces selected history and stale WAL', async () => {
    const source = path.join(root, 'slim')
    const current = path.join(root, 'current')
    const staged = path.join(root, 'staged')
    const key = 'c'.repeat(64)
    await fs.outputFile(path.join(current, 'Files', 'local.bin'), 'keep me')
    await fs.outputFile(path.join(current, 'agents.db-wal'), 'stale WAL')
    await fs.outputFile(path.join(current, 'OpenCode', key, 'data', 'old-wal'), 'stale native history')
    await fs.outputFile(path.join(source, 'agents.db'), 'new snapshot')
    await fs.outputFile(path.join(source, 'OpenCode', key, 'data', 'history'), 'restored history')
    await stageAssistantBackupData(source, current, staged, true)
    expect(await fs.readFile(path.join(staged, 'Files', 'local.bin'), 'utf8')).toBe('keep me')
    expect(await fs.pathExists(path.join(staged, 'agents.db-wal'))).toBe(false)
    expect(await fs.pathExists(path.join(staged, 'OpenCode', key, 'data', 'old-wal'))).toBe(false)
    expect(await fs.readFile(path.join(staged, 'agents.db'), 'utf8')).toBe('new snapshot')
    expect(await fs.readFile(path.join(current, 'agents.db-wal'), 'utf8')).toBe('stale WAL')
  })
})
