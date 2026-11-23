import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { writeAssistantOutput } from '@main/mcpServers/assistantFileSafety'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AssistantFileChangeStore, AssistantFileChangeTurn } from '../fileChanges'

vi.unmock('node:os')
vi.unmock('node:fs')

const fixtures: string[] = []

async function fixture() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'zen-file-changes-'))
  fixtures.push(root)
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  const storeRoot = path.join(root, 'history')
  const store = new AssistantFileChangeStore(storeRoot, 'session')
  const roots = [workspace]
  const turn = new AssistantFileChangeTurn(store, 'turn', roots, new AbortController().signal)
  return { root, storeRoot, workspace, store, roots, turn, trash: vi.fn(fs.unlink) }
}

afterEach(async () => {
  const tmp = await fs.realpath(os.tmpdir())
  for (const folder of fixtures.splice(0)) {
    if (path.dirname(folder) === tmp && path.basename(folder).startsWith('zen-file-changes-'))
      await fs.rm(folder, { recursive: true, force: true })
  }
})

describe('assistant file changes', () => {
  it('restores the original across multiple verified edits in one turn and retains the replaced version', async () => {
    const { workspace, storeRoot, store, roots, turn, trash } = await fixture()
    const file = path.join(workspace, '工作报告.txt')
    await fs.writeFile(file, 'Original')
    await turn.begin('first-edit', [file])
    await fs.writeFile(file, 'First edit')
    await turn.finish('first-edit')
    await turn.begin('second-edit', [file])
    await fs.writeFile(file, 'Final edit')
    await turn.finish('second-edit')
    await turn.close()

    const reopened = new AssistantFileChangeStore(storeRoot, 'session')
    const changes = await reopened.list()
    expect(changes).toEqual([expect.objectContaining({ path: file, kind: 'modified', canRestore: true, turn: 'turn' })])
    expect(await new AssistantFileChangeStore(storeRoot, 'other-session').list()).toEqual([])
    expect(await store.restore(changes[0].id, roots, trash)).toBe('restored')
    expect(await fs.readFile(file, 'utf8')).toBe('Original')
    const backupDir = path.join(workspace, '.zen-backups')
    const [backup] = await fs.readdir(backupDir)
    expect(await fs.readFile(path.join(backupDir, backup), 'utf8')).toBe('Final edit')
    expect((await reopened.list())[0].canRestore).toBe(false)
  })

  it('keeps later edits and rejects records outside the current authorized roots', async () => {
    const { root, workspace, store, roots, turn, trash } = await fixture()
    const file = path.join(workspace, 'report.txt')
    await fs.writeFile(file, 'Original')
    await writeAssistantOutput(file, 'Assistant edit', roots, {
      overwrite: true,
      approve: async () => true,
      onWrite: (file, backup) => turn.productWrite(file, backup)
    })
    const [record] = await store.list()
    expect(await store.preview(record.id, roots)).toMatchObject({
      before: 'Original',
      current: 'Assistant edit',
      changedSince: false,
      format: 'text'
    })
    expect(await store.preview(record.id, [path.join(root, 'different-folder')])).toBeUndefined()
    expect(await store.restore(record.id, [path.join(root, 'different-folder')], trash)).toBe('unavailable')
    await fs.writeFile(file, 'Later human edit')
    expect(await store.preview(record.id, roots)).toMatchObject({ current: 'Later human edit', changedSince: true })
    expect(await store.restore(record.id, roots, trash)).toBe('conflict')
    expect(await fs.readFile(file, 'utf8')).toBe('Later human edit')
    expect(trash).not.toHaveBeenCalled()
  })

  it('returns bounded metadata for unsupported binary files without exposing bytes', async () => {
    const { workspace, store, roots, turn } = await fixture()
    const file = path.join(workspace, 'sample.bin')
    await fs.writeFile(file, Buffer.from([0, 1, 2]))
    await turn.begin('edit', [file])
    await fs.writeFile(file, Buffer.from([0, 1, 2, 3]))
    await turn.finish('edit')
    const [record] = await store.list()
    expect(await store.preview(record.id, roots)).toEqual({
      format: 'metadata',
      beforeBytes: 3,
      currentBytes: 4,
      partial: false,
      changedSince: false
    })
  })

  it('records new files in new folders and sends only the exact unchanged file to trash', async () => {
    const { workspace, store, roots, turn, trash } = await fixture()
    const dir = path.join(workspace, 'new-folder')
    const file = path.join(dir, 'new.txt')
    await turn.begin('write', [file])
    await fs.mkdir(dir)
    await fs.writeFile(file, 'Created')
    await turn.finish('write')
    const [record] = await store.list()
    expect(record).toMatchObject({ kind: 'created' })
    expect(await store.restore(record.id, roots, trash)).toBe('restored')
    expect(trash).toHaveBeenCalledExactlyOnceWith(file)
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('records a verified Python edit after backup and delivery, while excluding abandoned and out-of-scope work', async () => {
    const { workspace, root, store, roots, turn, trash } = await fixture()
    const file = path.join(workspace, 'document.txt')
    const backup = path.join(workspace, 'backup.txt')
    const outside = path.join(root, 'outside.txt')
    await fs.writeFile(file, 'Original')
    await fs.copyFile(file, backup)
    await fs.writeFile(outside, 'Do not record')
    await turn.begin('abandoned', [file, outside])
    await turn.backedUp(file, backup)
    await fs.writeFile(file, 'Script result')
    await turn.presented([file])
    await turn.close()
    const changes = await store.list()
    expect(changes).toHaveLength(1)
    expect(await store.restore(changes[0].id, roots, trash)).toBe('restored')
    expect(await fs.readFile(file, 'utf8')).toBe('Original')
  })
})
