import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:os')
vi.unmock('node:path')

import { prepareOpenCodeInput } from '../inputMaterial'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-input-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (root && path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true })
})
const prepare = (text: string, signal = new AbortController().signal) =>
  prepareOpenCodeInput({ text, directory: path.join(root, 'inputs'), usableInput: 104_000, system: 'system', signal })

describe('large native input material', () => {
  it('leaves ordinary requests unchanged without creating files', async () => {
    expect(await prepare('你好，请分析附件')).toEqual({ text: '你好，请分析附件' })
    expect(await fs.readdir(root)).toEqual([])
  })

  it('preserves a huge first submission exactly, including Unicode, long lines and the final instruction', async () => {
    const text =
      '请逐项检查以下资料。\r\n' +
      '资料😀🧪"\\\u0000\t7319'.repeat(30_000) +
      '\n最后要求：分别核对各文件，不要混合结论。'
    const prepared = await prepare(text)
    expect(prepared.text.length).toBeLessThan(2500)
    const directory = prepared.material!.directory
    expect(await fs.readFile(path.join(directory, 'original.txt'), 'utf8')).toBe(text)
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'))
    expect(manifest.sha256).toBe(createHash('sha256').update(text).digest('hex'))
    expect(manifest.bytes).toBe(Buffer.byteLength(text))
    const lines = (await fs.readFile(path.join(directory, 'segments.jsonl'), 'utf8')).trimEnd().split('\n')
    expect(lines).toHaveLength(manifest.segmentCount)
    const records = lines.map((line) => JSON.parse(line))
    expect(records.map((record) => record.text).join('')).toBe(text)
    for (let index = 0; index < records.length; index++) {
      expect(lines[index].length).toBeLessThan(2000)
      expect(Buffer.byteLength(lines[index]) * manifest.readLines).toBeLessThan(24_000)
      expect(records[index].start).toBe(index === 0 ? 0 : records[index - 1].end)
      expect(records[index].text).toBe(text.slice(records[index].start, records[index].end))
      expect(records[index].text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
    }
    expect(JSON.parse(prepared.text.split('\n')[1]).manifest).toBe(path.join(directory, 'manifest.json'))
    expect(prepared.text).toContain('Do not claim full review')
    // Another turn never overwrites the resources retained for follow-ups.
    expect((await prepare(text)).material!.directory).not.toBe(directory)
    expect(await fs.readFile(path.join(directory, 'original.txt'), 'utf8')).toBe(text)
  })

  it('uses capacity and system overhead rather than a fixed text length cutoff', async () => {
    const text = 'X'.repeat(40_000)
    const base = { text, directory: path.join(root, 'inputs'), system: '', signal: new AbortController().signal }
    expect((await prepareOpenCodeInput({ ...base, usableInput: 960_000 })).material).toBeUndefined()
    expect((await prepareOpenCodeInput({ ...base, usableInput: 104_000 })).material).toBeDefined()
    expect(
      (await prepareOpenCodeInput({ ...base, usableInput: 960_000, system: 'X'.repeat(220_000) })).material
    ).toBeDefined()
  })

  it('does not send or keep a partial material when cancelled during preparation', async () => {
    const abort = new AbortController()
    const write = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      const result = await write(...args)
      abort.abort(new Error('cancelled by user'))
      return result
    })
    await expect(prepare('X'.repeat(100_000), abort.signal)).rejects.toThrow('cancelled by user')
    expect(await fs.readdir(path.join(root, 'inputs'))).toEqual([])
  })

  it('reports write failure without falling back to a huge upstream request', async () => {
    vi.spyOn(fs, 'writeFile').mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
    await expect(prepare('X'.repeat(100_000))).rejects.toMatchObject({ code: 'agent_input_preparation_failed' })
    expect(await fs.readdir(path.join(root, 'inputs'))).toEqual([])
  })

  it('refuses redirected input storage without writing into the linked directory', async () => {
    const outside = path.join(root, 'other-data')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'keep.txt'), 'keep')
    await fs.symlink(outside, path.join(root, 'inputs'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(prepare('X'.repeat(100_000))).rejects.toMatchObject({ code: 'agent_input_preparation_failed' })
    expect(await fs.readdir(outside)).toEqual(['keep.txt'])
  })
})
