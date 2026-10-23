import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'

import { checkOriginals, generateFiles, generateLargeFiles, inspectOutput, safeFile } from '../files'

describe('independent office gold fixtures', () => {
  it('creates seven formats and checks actual bodies rather than file existence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-office-'))
    try {
      const files = await generateFiles(directory)
      expect(Object.keys(files)).toHaveLength(7)
      for (const format of ['json', 'docx', 'xlsx', 'pptx', 'pdf'] as const) {
        const result = await inspectOutput(directory, files[format].file, format)
        expect(result.structurallyReadable).toBe(true)
        expect(result.sha256).toBe(files[format].sha256)
        await expect(inspectOutput(directory, files[format].file, format, ['MADE-UP-NONEXISTENT'])).rejects.toThrow(
          '缺少'
        )
      }
      await checkOriginals(directory, files)
      await writeFile(files.json.file, '{"total":999}')
      await expect(checkOriginals(directory, files)).rejects.toThrow('原件')
      await expect(safeFile(path.join(directory, 'gold'), files.docx.file)).rejects.toThrow()
      const zip = new AdmZip(await readFile(files.docx.file))
      zip.deleteFile('word/document.xml')
      await writeFile(files.docx.file, zip.toBuffer())
      await expect(inspectOutput(directory, files.docx.file, 'docx')).rejects.toThrow('没有正文')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
  it('makes genuine >10MiB aggregate source files, not large metadata claims', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-large-files-'))
    try {
      const result = await generateLargeFiles(directory)
      expect(result.files.reduce((sum, file) => sum + file.bytes, 0)).toBeGreaterThan(10 * 1024 * 1024)
      const sums = await Promise.all(
        result.files.map(async (file) =>
          JSON.parse((await readFile(file.file)).toString()).amounts.reduce((a: number, b: number) => a + b, 0)
        )
      )
      expect(sums.reduce((a, b) => a + b, 0)).toBe(100)
      await expect(inspectOutput(directory, result.corrupt, 'docx')).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
