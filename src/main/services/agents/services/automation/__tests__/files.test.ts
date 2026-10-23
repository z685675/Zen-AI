import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AUTOMATION_FILE_LIMIT,
  automationOutputPaths,
  safeAutomationReply,
  saveAutomationInput,
  verifiedAutomationFile
} from '../files'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.unmock('node:path')

describe('automation file perimeter', () => {
  let root: string
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-automation-files-'))
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('uses independent generated names, never a remote path or overwrite', async () => {
    const one = await saveAutomationInput(root, '../../private/notes.txt', Buffer.from('one'))
    const two = await saveAutomationInput(root, '../../private/notes.txt', Buffer.from('two'))
    expect(path.dirname(one)).toBe(path.join(root, 'inputs'))
    expect(one).not.toBe(two)
    expect(await fs.readFile(one, 'utf8')).toBe('one')
    expect((await verifiedAutomationFile(two, root)).sha256).toHaveLength(64)
  })
  it('rejects outside paths, hidden internal files, empty, oversized and executable input', async () => {
    const hidden = path.join(root, '.credentials.txt')
    await fs.writeFile(hidden, 'secret')
    await expect(verifiedAutomationFile(hidden, root)).rejects.toThrow('outside_workspace')
    await expect(verifiedAutomationFile(path.join(root, '..'), root)).rejects.toThrow('outside_workspace')
    await expect(saveAutomationInput(root, 'a.exe', Buffer.from('x'))).rejects.toThrow('unsupported')
    await expect(saveAutomationInput(root, 'a.txt', Buffer.alloc(0))).rejects.toThrow('unsupported')
    await expect(saveAutomationInput(root, 'a.txt', Buffer.alloc(AUTOMATION_FILE_LIMIT + 1))).rejects.toThrow('large')
  })
  it.each(['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg'])('rejects a forged %s signature', async (extension) => {
    await expect(saveAutomationInput(root, `a.${extension}`, Buffer.from('this is not that format'))).rejects.toThrow(
      'format_mismatch'
    )
  })
  it('rejects a junction that redirects the input folder', async () => {
    const outside = path.join(root, 'elsewhere')
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(root, 'inputs'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(saveAutomationInput(root, 'a.txt', Buffer.from('x'))).rejects.toThrow('directory_changed')
    expect(await fs.readdir(outside)).toEqual([])
  })
  it('takes paths only from completed controlled output records, not prose or failed tools', () => {
    const block = (name: string, response: unknown, status = 'done') => ({
      type: 'tool',
      metadata: { rawMcpToolResponse: { status, tool: { name }, response } }
    })
    expect(
      automationOutputPaths([
        { type: 'main_text', content: '/private/secret.txt' } as any,
        block('mcp__assistant__create_file', { status: 'created', path: '/out/result.docx' }),
        block('mcp__assistant__present_files', { status: 'ready', files: [{ path: '/out/slides.pptx' }] }),
        block('bash', { status: 'created', path: '/private.txt' }),
        block('create_file', { status: 'created', path: '/bad.txt' }, 'error'),
        block('create_file', { isError: true, status: 'created', path: '/bad2.txt' })
      ])
    ).toEqual(['/out/result.docx', '/out/slides.pptx'])
    expect(
      safeAutomationReply(
        'file C:\\Users\\me\\private.txt and /Users/me/notes.txt Bearer abcdefghijklmnop sk-abcdefghijklmnop'
      )
    ).not.toMatch(/private.txt|notes.txt|abcdefghijklmnop/)
  })
})
