import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { readAssistantToolFailure } from '@shared/agents/toolFailure'
import AdmZip from 'adm-zip'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  executePython: vi.fn(),
  executePythonScript: vi.fn(),
  getPythonStatus: vi.fn(),
  listOcrProviders: vi.fn(),
  ocr: vi.fn()
}))

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.unmock('node:path')
vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() })
  }
}))
vi.mock('@main/utils', () => ({ toAsarUnpackedPath: (value: string) => value }))
vi.mock('@main/services/python/ManagedPythonService', () => ({
  managedPythonService: {
    execute: mocks.executePython,
    executeScript: mocks.executePythonScript,
    getStatus: mocks.getPythonStatus
  }
}))
vi.mock('@main/services/ocr/OcrService', () => ({
  ocrService: {
    listProviderIds: mocks.listOcrProviders,
    ocr: mocks.ocr
  }
}))
vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => 'test',
    getName: () => 'Zen AI',
    getLocale: () => 'zh-CN',
    isPackaged: false
  }
}))

import AssistantServer from '../assistant'
import { createDocxBuffer } from '../assistantDocx'
import type { AssistantProductOptions } from '../assistantProductTools'

const tempDirs: string[] = []

async function createClient(allowedRoot: string, product?: AssistantProductOptions) {
  const assistant = new AssistantServer([allowedRoot], product)
  const client = new Client({ name: 'assistant-runtime-tools-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await assistant.mcpServer.connect(serverTransport)
  await client.connect(clientTransport)
  return { assistant, client }
}

beforeEach(() => {
  mocks.executePython.mockReset()
  mocks.executePythonScript.mockReset()
  mocks.getPythonStatus.mockReset()
  mocks.listOcrProviders.mockReset()
  mocks.ocr.mockReset()
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('AssistantServer runtime tools', () => {
  it('enforces the actual background tool allowlist even for direct hidden-tool calls', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-lightweight-tools-'))
    tempDirs.push(root)
    const approve = vi.fn(async () => true)
    const { assistant, client } = await createClient(root, {
      workspace: root,
      readNativeSkills: async () => [],
      approveOverwrite: approve,
      allowedTools: ['create_file', 'read_document', 'present_files']
    })
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        'create_file',
        'present_files',
        'read_document'
      ])
      expect((await client.callTool({ name: 'python_execute', arguments: { code: 'print(1)' } })).isError).toBe(true)
      expect(mocks.executePython).not.toHaveBeenCalled()
      const original = path.join(root, 'original.txt')
      await fs.writeFile(original, 'unchanged')
      const denied = await client.callTool({
        name: 'create_file',
        arguments: { file_path: original, format: 'txt', content: 'replacement', overwrite: true }
      })
      expect(denied.isError).toBe(true)
      expect(approve).not.toHaveBeenCalled()
      expect(await fs.readFile(original, 'utf8')).toBe('unchanged')
      const outside = await client.callTool({
        name: 'read_document',
        arguments: { file_path: path.join(root, '..', 'outside.txt') }
      })
      expect(outside.isError).toBe(true)
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })
  it('returns actionable new-assistant failures and marks nonzero Python exits as failed observations', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-tool-failure-'))
    tempDirs.push(root)
    const observe = vi.fn()
    const { assistant, client } = await createClient(root, {
      workspace: root,
      readNativeSkills: async () => [],
      approveOverwrite: async () => false,
      onTool: observe
    })
    mocks.executePython.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: "ModuleNotFoundError: No module named 'missing'; password=secret " + 'trace '.repeat(12_000),
      durationMs: 10
    })
    try {
      const failed = await client.callTool({ name: 'python_execute', arguments: { code: 'import missing' } })
      expect(failed.isError).toBe(true)
      expect(readAssistantToolFailure(failed)?.code).toBe('dependency')
      expect(JSON.stringify(failed).length).toBeLessThan(35_000)
      expect(JSON.stringify(failed)).not.toContain('password=secret')
      expect(mocks.executePython).toHaveBeenCalledOnce()
      expect(observe).toHaveBeenCalledWith('python_execute', expect.any(Number), true)
      const missing = await client.callTool({ name: 'backup_file', arguments: { file_path: 'absent.txt' } })
      expect(readAssistantToolFailure(missing)?.code).toBe('missing_file')
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('rejects unsafe Office results before writing or requesting overwrite approval', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-office-quality-'))
    tempDirs.push(root)
    const approve = vi.fn(async () => true)
    const { assistant, client } = await createClient(root, {
      workspace: root,
      readNativeSkills: async () => [],
      approveOverwrite: approve
    })
    const output = path.join(root, 'existing.xlsx')
    await fs.writeFile(output, 'original')
    try {
      const formula = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: output,
          format: 'xlsx',
          overwrite: true,
          render_validation: 'skip',
          workbook: { sheets: [{ rows: [[{ formula: '1+1' }]] }] }
        }
      })
      expect(readAssistantToolFailure(formula)?.code).toBe('validation')
      expect(await fs.readFile(output, 'utf8')).toBe('original')
      expect(approve).not.toHaveBeenCalled()
      const deck = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: 'overfull.pptx',
          format: 'pptx',
          render_validation: 'skip',
          slides: [{ title: 'Test', layout: 'cover', bullets: ['One', 'Two', 'Three', 'Four'] }]
        }
      })
      expect(readAssistantToolFailure(deck)?.code).toBe('validation')
      await expect(fs.stat(path.join(root, 'overfull.pptx'))).rejects.toMatchObject({ code: 'ENOENT' })
      const success = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: 'safe.xlsx',
          format: 'xlsx',
          render_validation: 'skip',
          workbook: { sheets: [{ header_rows: 0, rows: [[{ formula: '1+1', result: 2, style: 'decimal' }]] }] }
        }
      })
      expect(success.isError).not.toBe(true)
      expect((await fs.stat(path.join(root, 'safe.xlsx'))).size).toBeGreaterThan(0)
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('exposes new product tools only in the new assistant, without outbound search on discovery', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-product-tools-'))
    tempDirs.push(root)
    const readNativeSkills = vi.fn(async () => [
      { name: 'xlsx', location: '/native/winner/SKILL.md', content: 'private body' }
    ])
    const product: AssistantProductOptions = { workspace: root, readNativeSkills, approveOverwrite: async () => false }
    for (const options of [undefined, product]) {
      const { assistant, client } = await createClient(root, options)
      try {
        const names = (await client.listTools()).tools.map((tool) => tool.name)
        expect(names.includes('web_search')).toBe(Boolean(options))
        expect(names.includes('prepare_file_copy')).toBe(Boolean(options))
        expect(readNativeSkills).not.toHaveBeenCalled()
        if (options) {
          const status = await client.callTool({ name: 'skill_status', arguments: {} })
          expect(JSON.stringify(status)).toContain('/native/winner/SKILL.md')
          expect(JSON.stringify(status)).not.toContain('private body')
          const environment = await client.callTool({ name: 'environment', arguments: {} })
          expect(JSON.parse((environment.content[0] as any).text).workspace).toBe(root)
          expect(JSON.stringify(environment)).toContain('informational only')
        }
      } finally {
        await client.close()
        await assistant.mcpServer.close()
      }
    }
  })
  it('protects existing new-assistant outputs and returns backup metadata for approved replacements', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-product-backup-'))
    tempDirs.push(root)
    const file = path.join(root, 'report.txt')
    await fs.writeFile(file, 'Original report')
    const approve = vi.fn(async () => true)
    const { assistant, client } = await createClient(root, {
      workspace: root,
      readNativeSkills: async () => [],
      approveOverwrite: approve
    })
    try {
      const savedCopy = await client.callTool({
        name: 'create_file',
        arguments: { file_path: file, format: 'txt', content: 'New content' }
      })
      expect(savedCopy.isError).not.toBe(true)
      const copied = JSON.parse((savedCopy.content[0] as any).text)
      expect(copied.path).toBe(path.join(root, 'report (1).txt'))
      expect(await fs.readFile(copied.path, 'utf8')).toBe('New content')
      expect(approve).not.toHaveBeenCalled()
      expect(await fs.readFile(file, 'utf8')).toBe('Original report')
      const result = await client.callTool({
        name: 'create_file',
        arguments: { file_path: file, format: 'txt', content: 'New content', overwrite: true }
      })
      expect(result.isError).not.toBe(true)
      const payload = JSON.parse((result.content[0] as any).text)
      expect(await fs.readFile(payload.backup_path, 'utf8')).toBe('Original report')
      expect(approve).toHaveBeenCalledOnce()
      expect(payload.write_mode).toBe('replaced-with-backup')
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })
  it('prepares a real Excel working copy and delivers an edited result without changing the source', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-office-copy-'))
    tempDirs.push(root)
    const approve = vi.fn(async () => false)
    const { assistant, client } = await createClient(root, {
      workspace: root,
      readNativeSkills: async () => [],
      approveOverwrite: approve
    })
    try {
      const created = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: '原始.xlsx',
          format: 'xlsx',
          rows: [
            ['Item', 'Total'],
            ['A', 10]
          ],
          render_validation: 'skip'
        }
      })
      expect(created.isError).not.toBe(true)
      const original = path.join(root, '原始.xlsx')
      const originalBytes = await fs.readFile(original)
      const copied = await client.callTool({ name: 'prepare_file_copy', arguments: { file_path: original } })
      expect(copied.isError).not.toBe(true)
      const payload = JSON.parse((copied.content[0] as any).text)
      expect(payload.status).toBe('working-copy-created')
      expect(payload.working_path).toBe(path.join(root, 'outputs', '原始-edited.xlsx'))
      expect(await fs.readFile(payload.working_path)).toEqual(originalBytes)
      // A Skill can modify the independent package in place without touching the source.
      const zip = new AdmZip(await fs.readFile(payload.working_path))
      zip.addFile('zen-edit.txt', Buffer.from('test modification'))
      await fs.writeFile(payload.working_path, zip.toBuffer())
      const presented = await client.callTool({
        name: 'present_files',
        arguments: { file_paths: [payload.working_path] }
      })
      expect(presented.isError).not.toBe(true)
      expect(await fs.readFile(original)).toEqual(originalBytes)
      const repeated = await client.callTool({ name: 'prepare_file_copy', arguments: { file_path: original } })
      const another = JSON.parse((repeated.content[0] as any).text)
      expect(another.working_path).toBe(path.join(root, 'outputs', '原始-edited (1).xlsx'))
      expect(approve).not.toHaveBeenCalled()
      const escaped = await client.callTool({
        name: 'prepare_file_copy',
        arguments: { file_path: original, output_path: path.join(root, '..', 'escape.xlsx') }
      })
      expect(escaped.isError).toBe(true)
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })
  it('enforces read-only product context even when a mutating MCP tool is directly requested', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-product-plan-'))
    tempDirs.push(root)
    const { assistant, client } = await createClient(root, {
      workspace: root,
      readOnly: true,
      readNativeSkills: async () => [],
      approveOverwrite: async () => true
    })
    try {
      const result = await client.callTool({
        name: 'create_file',
        arguments: { file_path: 'no.txt', format: 'txt', content: 'No' }
      })
      expect(result.isError).toBe(true)
      const copied = await client.callTool({ name: 'prepare_file_copy', arguments: { file_path: 'no.txt' } })
      expect(copied.isError).toBe(true)
      expect(JSON.stringify(copied)).toContain('Plan mode')
      expect(await fs.readdir(root)).toEqual([])
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })
  it('creates a DOCX without inferring a duplicate source table from Markdown content', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-docx-'))
    tempDirs.push(root)
    const outputPath = path.join(root, 'report.docx')
    const { assistant, client } = await createClient(root)

    try {
      const result = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: outputPath,
          format: 'docx',
          title: 'Runtime Report',
          content: '# Runtime Report\n\n**Result:** complete\n\n| Item | Status |\n| --- | --- |\n| Runtime | Passed |'
        }
      })
      expect(result.isError).not.toBe(true)

      const zip = new AdmZip(await fs.readFile(outputPath))
      const documentXml = zip.readAsText('word/document.xml')
      expect(documentXml.match(/Runtime Report/g)).toHaveLength(1)
      expect(documentXml.match(/<w:tbl>/g)).toHaveLength(1)
      expect(documentXml).not.toContain('**Result:**')
      expect(documentXml).not.toContain('| --- | --- |')
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: expect.stringContaining('ooxml-relationships') })
        ])
      )
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('registers existing final files for quick-open delivery cards', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-present-files-'))
    tempDirs.push(root)
    const reportPath = path.join(root, 'report.docx')
    const sourcesPath = path.join(root, 'sources.csv')
    await fs.writeFile(reportPath, await createDocxBuffer('Runtime Report', 'Actual report content', []))
    await fs.writeFile(sourcesPath, 'source,url')
    const { assistant, client } = await createClient(root)

    try {
      const result = await client.callTool({
        name: 'present_files',
        arguments: {
          file_paths: [reportPath, sourcesPath]
        }
      })
      expect(result.isError).not.toBe(true)

      const payload = JSON.parse((result.content[0] as { type: 'text'; text: string }).text)
      expect(payload).toMatchObject({
        status: 'ready',
        files: [
          {
            path: reportPath,
            format: 'docx',
            verified: true,
            verification_scope: 'structure-and-content',
            verification: { checks: expect.arrayContaining(['ooxml-package', 'docx-body-content']) }
          },
          {
            path: sourcesPath,
            format: 'csv',
            size: 10,
            verified: true,
            verification_scope: 'structure-and-content'
          }
        ]
      })

      const missing = await client.callTool({
        name: 'present_files',
        arguments: {
          file_paths: [path.join(root, 'missing.pdf')]
        }
      })
      expect(missing.isError).toBe(true)
      expect(JSON.stringify(missing.content)).toContain('does not exist')
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('rejects a fake Office deliverable without publishing success cards or removing other outputs', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-invalid-delivery-'))
    tempDirs.push(root)
    const valid = path.join(root, 'valid.txt')
    const fake = path.join(root, 'fake.xlsx')
    await fs.writeFile(valid, 'A real result')
    await fs.writeFile(fake, 'This is not an Excel workbook')
    const { assistant, client } = await createClient(root)
    try {
      const result = await client.callTool({ name: 'present_files', arguments: { file_paths: [valid, fake] } })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).not.toContain('"status":"ready"')
      expect(JSON.stringify(result.content)).toContain('fake.xlsx')
      expect(await fs.readFile(valid, 'utf8')).toBe('A real result')
      expect(await fs.readFile(fake, 'utf8')).toBe('This is not an Excel workbook')
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('keeps unsupported files openable without marking them content-verified', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-existence-delivery-'))
    tempDirs.push(root)
    const output = path.join(root, 'app.js')
    await fs.writeFile(output, 'export const result = 1')
    const { assistant, client } = await createClient(root)
    try {
      const result = await client.callTool({ name: 'present_files', arguments: { file_paths: [output, output] } })
      expect(result.isError).not.toBe(true)
      const payload = JSON.parse((result.content[0] as { text: string }).text)
      expect(payload.files).toHaveLength(1)
      expect(payload.files[0]).toMatchObject({ path: output, verified: false, verification_scope: 'existence-only' })
      expect(payload.files[0].warnings).not.toHaveLength(0)
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('registers existing output folders for persistent shortcuts, still enforcing allowed roots', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-present-folder-'))
    tempDirs.push(root)
    const project = path.join(root, 'project')
    await fs.mkdir(project)
    const { assistant, client } = await createClient(root)
    try {
      const result = await client.callTool({ name: 'present_files', arguments: { file_paths: [project] } })
      expect(result.isError).not.toBe(true)
      const payload = JSON.parse((result.content[0] as { text: string }).text)
      expect(payload.files).toEqual([expect.objectContaining({ path: project, kind: 'directory', verified: true })])
      const outside = await client.callTool({ name: 'present_files', arguments: { file_paths: [path.dirname(root)] } })
      expect(outside.isError).toBe(true)
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('validates Markdown structure before writing the final file', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-markdown-'))
    tempDirs.push(root)
    const validPath = path.join(root, 'valid.md')
    const invalidPath = path.join(root, 'invalid.md')
    const { assistant, client } = await createClient(root)

    try {
      const valid = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: validPath,
          format: 'md',
          content: '# Delivery\n\n## Result\n\n```text\npassed\n```'
        }
      })
      expect(valid.isError).not.toBe(true)
      expect(valid.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: expect.stringContaining('markdown-structure') })
        ])
      )

      const invalid = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: invalidPath,
          format: 'md',
          content: '# Broken\n\n```text\nnot closed'
        }
      })
      expect(invalid.isError).toBe(true)
      await expect(fs.stat(invalidPath)).rejects.toThrow()
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('rejects missing and unauthorized image assets before writing output', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-assets-'))
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-assets-outside-'))
    tempDirs.push(root, outside)
    const unauthorizedImage = path.join(outside, 'outside.png')
    await fs.writeFile(
      unauthorizedImage,
      await sharp({ create: { width: 20, height: 20, channels: 3, background: '#336699' } })
        .png()
        .toBuffer()
    )
    const missingOutput = path.join(root, 'missing.docx')
    const unauthorizedOutput = path.join(root, 'unauthorized.docx')
    const { assistant, client } = await createClient(root)

    try {
      const missing = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: missingOutput,
          format: 'docx',
          content: '![Missing](asset:hero)',
          assets: [{ id: 'hero', file_path: path.join(root, 'missing.png') }]
        }
      })
      expect(missing.isError).toBe(true)

      const unauthorized = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: unauthorizedOutput,
          format: 'docx',
          content: '![Outside](asset:hero)',
          assets: [{ id: 'hero', file_path: unauthorizedImage }]
        }
      })
      expect(unauthorized.isError).toBe(true)
      await expect(fs.stat(missingOutput)).rejects.toThrow()
      await expect(fs.stat(unauthorizedOutput)).rejects.toThrow()
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('loads an authorized local image and embeds it through create_file', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-embedded-asset-'))
    tempDirs.push(root)
    const imagePath = path.join(root, 'preview.png')
    const outputPath = path.join(root, 'report.docx')
    await fs.writeFile(
      imagePath,
      await sharp({ create: { width: 320, height: 180, channels: 3, background: '#336699' } })
        .png()
        .toBuffer()
    )
    const { assistant, client } = await createClient(root)

    try {
      const result = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: outputPath,
          format: 'docx',
          title: 'Image report',
          content: '# Image report\n\n![Preview](asset:preview)',
          assets: [{ id: 'preview', file_path: imagePath, alt_text: 'Product preview' }],
          render_validation: 'skip'
        }
      })
      expect(result.isError).not.toBe(true)
      const zip = new AdmZip(await fs.readFile(outputPath))
      expect(zip.getEntries().some((entry) => entry.entryName.startsWith('word/media/'))).toBe(true)
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: expect.stringContaining('embedded-media') })
        ])
      )
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('advertises managed Python and OCR tools', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-tools-'))
    tempDirs.push(root)
    const { assistant, client } = await createClient(root)

    try {
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['create_file', 'present_files', 'inspect_pptx_template', 'python_execute', 'ocr_file'])
      )
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('advertises document style controls and reports the automatically resolved style', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-styles-'))
    tempDirs.push(root)
    const outputPath = path.join(root, 'family-guide.docx')
    const { assistant, client } = await createClient(root)

    try {
      const tools = await client.listTools()
      const createFile = tools.tools.find((tool) => tool.name === 'create_file')
      const properties = (createFile?.inputSchema as { properties?: Record<string, unknown> })?.properties || {}
      expect(properties).toEqual(
        expect.objectContaining({
          visual_style: expect.any(Object),
          document_type: expect.any(Object),
          style_mode: expect.any(Object),
          brand_theme: expect.any(Object),
          pptx_style_reference: expect.any(Object),
          pptx_template: expect.any(Object)
        })
      )
      expect(JSON.stringify(createFile?.inputSchema)).toContain('preserve_content')
      expect(JSON.stringify(createFile?.inputSchema)).toContain('terse user request')
      expect(JSON.stringify(createFile?.inputSchema)).toContain('without follow-up prompting')

      const result = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: outputPath,
          format: 'docx',
          title: '小学家庭教育指南',
          content: '# 小学家庭教育指南\n\n面向家长和儿童的亲子学习活动。',
          render_validation: 'skip'
        }
      })
      expect(result.isError).not.toBe(true)
      const text = result.content.find((item) => item.type === 'text')
      const payload = JSON.parse(text?.type === 'text' ? text.text : '{}')
      expect(payload).toEqual(
        expect.objectContaining({
          visual_style: 'children',
          visual_style_label: '儿童教育',
          visual_style_source: 'inferred',
          style_mode: 'light',
          document_type: 'auto'
        })
      )
      expect(payload.verification.details).toEqual(
        expect.objectContaining({ visual_style: 'children', visual_style_source: 'inferred' })
      )
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('creates a new deck from an authorized PPTX style reference without modifying the source', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-pptx-reference-'))
    tempDirs.push(root)
    const referencePath = path.join(root, 'reference.pptx')
    const outputPath = path.join(root, 'adapted.pptx')
    const explicitOutputPath = path.join(root, 'explicit-style.pptx')
    const { assistant, client } = await createClient(root)

    try {
      const reference = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: referencePath,
          format: 'pptx',
          title: '探索自然的周末课堂',
          visual_style: 'children',
          slides: [
            {
              title: '探索自然的周末课堂',
              subtitle: '让好奇心带路',
              layout: 'cover',
              bullets: ['自然观察', '动手实验', '表达分享']
            }
          ],
          render_validation: 'skip'
        }
      })
      expect(reference.isError).not.toBe(true)
      const originalReference = await fs.readFile(referencePath)

      const result = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: outputPath,
          format: 'pptx',
          title: '城市公共空间共创计划',
          pptx_style_reference: { file_path: referencePath, slide_number: 1 },
          slides: [
            {
              title: '让公共空间重新连接社区',
              subtitle: '城市公共空间共创计划',
              layout: 'cover',
              bullets: ['共同观察', '共同设计', '共同维护']
            }
          ],
          render_validation: 'skip'
        }
      })
      expect(result.isError).not.toBe(true)

      const textContent = result.content.find((item) => item.type === 'text')
      const payload = JSON.parse(textContent?.type === 'text' ? textContent.text : '{}')
      expect(payload).toEqual(
        expect.objectContaining({
          visual_style: 'children',
          visual_style_source: 'reference',
          pptx_style_reference: expect.objectContaining({
            kind: 'pptx',
            analyzed_slide: 1,
            layout_confidence: 'high'
          })
        })
      )
      expect(payload.verification.details).toEqual(
        expect.objectContaining({
          visual_style_source: 'reference',
          style_reference_kind: 'pptx',
          style_reference_slide: 1
        })
      )

      const output = new AdmZip(await fs.readFile(outputPath))
      expect(output.readAsText('ppt/slides/slide1.xml')).toContain('Playful orbit large')
      expect(await fs.readFile(referencePath)).toEqual(originalReference)

      const explicitResult = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: explicitOutputPath,
          format: 'pptx',
          title: 'Reference style leads',
          visual_style: 'consulting',
          style_mode: 'dark',
          brand_theme: { primary_color: 'A1B2C3' },
          pptx_style_reference: { file_path: referencePath, slide_number: 1 },
          slides: [{ title: 'Reference style leads', layout: 'cover', bullets: ['Reference choice'] }],
          render_validation: 'skip'
        }
      })
      expect(explicitResult.isError).not.toBe(true)
      const explicitText = explicitResult.content.find((item) => item.type === 'text')
      const explicitPayload = JSON.parse(explicitText?.type === 'text' ? explicitText.text : '{}')
      expect(explicitPayload).toEqual(
        expect.objectContaining({
          visual_style: 'children',
          visual_style_source: 'reference',
          style_mode: 'dark'
        })
      )
      expect(explicitPayload.verification.checks).toContain('pptx-reference-composition')
      expect(explicitPayload.verification.warnings.join(' ')).toContain("visual_style 'consulting' was ignored")
      const explicitOutput = new AdmZip(await fs.readFile(explicitOutputPath))
      const explicitSlideXml = explicitOutput.readAsText('ppt/slides/slide1.xml')
      expect(explicitSlideXml).toContain('Playful orbit large')
      expect(explicitSlideXml).not.toContain('Consulting cover divider')
      expect(await fs.readFile(referencePath)).toEqual(originalReference)
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('rejects a text-only deck for an image-heavy PPTX style reference', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-pptx-reference-media-'))
    tempDirs.push(root)
    const imagePath = path.join(root, 'reference-hero.png')
    const referencePath = path.join(root, 'image-reference.pptx')
    const blockedPath = path.join(root, 'blocked-text-only.pptx')
    const adaptedPath = path.join(root, 'adapted-with-image.pptx')
    await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#4B7751' } })
      .png()
      .toFile(imagePath)
    const { assistant, client } = await createClient(root)

    try {
      const reference = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: referencePath,
          format: 'pptx',
          title: 'Image-led reference',
          visual_style: 'editorial',
          slides: [
            {
              title: 'Image-led reference',
              layout: 'image',
              bullets: ['Visual evidence'],
              image_asset_id: 'hero'
            }
          ],
          assets: [{ id: 'hero', file_path: imagePath, alt_text: 'Reference visual' }],
          render_validation: 'skip'
        }
      })
      expect(reference.isError).not.toBe(true)

      const blocked = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: blockedPath,
          format: 'pptx',
          title: 'Text-only adaptation',
          visual_style: 'research',
          pptx_style_reference: { file_path: referencePath },
          slides: [{ title: 'Text-only adaptation', layout: 'insight', bullets: ['No image'] }],
          render_validation: 'skip'
        }
      })
      expect(blocked.isError).toBe(true)
      expect(JSON.stringify(blocked.content)).toContain('image-heavy')
      await expect(fs.stat(blockedPath)).rejects.toThrow()

      const adapted = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: adaptedPath,
          format: 'pptx',
          title: 'Image-backed adaptation',
          visual_style: 'research',
          pptx_style_reference: { file_path: referencePath },
          slides: [
            {
              title: 'Image-backed adaptation',
              layout: 'image',
              bullets: ['Relevant visual evidence'],
              image_asset_id: 'hero'
            }
          ],
          assets: [{ id: 'hero', file_path: imagePath, alt_text: 'Adapted visual' }],
          render_validation: 'skip'
        }
      })
      expect(adapted.isError).not.toBe(true)
      const adaptedText = adapted.content.find((item) => item.type === 'text')
      const adaptedPayload = JSON.parse(adaptedText?.type === 'text' ? adaptedText.text : '{}')
      expect(adaptedPayload.visual_style).toBe('editorial')
      expect(adaptedPayload.visual_style_source).toBe('reference')
      expect(adaptedPayload.verification.checks).toContain('pptx-reference-composition')
      expect(adaptedPayload.verification.details.output_picture_slide_ratio).toBe(1)

      const repeatedReferencePath = path.join(root, 'repeated-image-reference.pptx')
      const repeatedOutputPath = path.join(root, 'blocked-repeated-images.pptx')
      const photoSlides = Array.from({ length: 6 }, (_, index) => ({
        title: `Photo page ${index + 1}`,
        layout: 'image',
        bullets: ['Visual evidence'],
        image_asset_id: 'hero'
      }))
      const repeatedReference = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: repeatedReferencePath,
          format: 'pptx',
          title: 'Photo-led reference',
          visual_style: 'editorial',
          slides: photoSlides,
          assets: [{ id: 'hero', file_path: imagePath, alt_text: 'Reference visual' }],
          render_validation: 'skip'
        }
      })
      expect(repeatedReference.isError).not.toBe(true)

      const repeatedOutput = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: repeatedOutputPath,
          format: 'pptx',
          title: 'Repeated image adaptation',
          pptx_style_reference: { file_path: repeatedReferencePath },
          slides: photoSlides,
          assets: [{ id: 'hero', file_path: imagePath, alt_text: 'Repeated output visual' }],
          render_validation: 'skip'
        }
      })
      expect(repeatedOutput.isError).toBe(true)
      expect(JSON.stringify(repeatedOutput.content)).toContain('distinct image file')
      await expect(fs.stat(repeatedOutputPath)).rejects.toThrow()
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('rejects unauthorized and unsupported PPT style references', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-pptx-reference-root-'))
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-pptx-reference-outside-'))
    tempDirs.push(root, outside)
    const outsideReference = path.join(outside, 'outside.pptx')
    const textReference = path.join(root, 'reference.txt')
    await fs.writeFile(outsideReference, 'not needed')
    await fs.writeFile(textReference, 'not a presentation')
    const { assistant, client } = await createClient(root)

    try {
      for (const [name, referencePath] of [
        ['unauthorized', outsideReference],
        ['unsupported', textReference]
      ]) {
        const result = await client.callTool({
          name: 'create_file',
          arguments: {
            file_path: path.join(root, `${name}.pptx`),
            format: 'pptx',
            pptx_style_reference: { file_path: referencePath },
            slides: [{ title: 'Reference check', layout: 'cover', bullets: ['Safe input'] }],
            render_validation: 'skip'
          }
        })
        expect(result.isError).toBe(true)
      }
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('reuses a native PPTX template through create_file and preserves unedited pages', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-native-pptx-template-'))
    tempDirs.push(root)
    const templatePath = path.join(root, 'template.pptx')
    const outputPath = path.join(root, 'edited-copy.pptx')
    const { assistant, client } = await createClient(root)

    try {
      const templateResult = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: templatePath,
          format: 'pptx',
          visual_style: 'premium',
          slides: [
            { title: 'Original cover', layout: 'cover', bullets: ['Context'] },
            { title: 'Original plan', layout: 'cards', bullets: ['One', 'Two', 'Three'] }
          ],
          render_validation: 'skip'
        }
      })
      expect(templateResult.isError).not.toBe(true)
      const inspection = await client.callTool({
        name: 'inspect_pptx_template',
        arguments: { file_path: templatePath }
      })
      expect(inspection.isError).not.toBe(true)
      const inspectionText = inspection.content.find((item) => item.type === 'text')
      const inspectionPayload = JSON.parse(inspectionText?.type === 'text' ? inspectionText.text : '{}')
      expect(inspectionPayload).toEqual(
        expect.objectContaining({
          source_path: templatePath,
          slide_count: 2,
          design_language: expect.objectContaining({
            shape_language: expect.any(String),
            content_density: expect.any(String),
            page_rhythm: expect.any(String)
          }),
          deck_targets: expect.objectContaining({
            minimum_text_density_ratio: expect.any(Number),
            minimum_layout_diversity_ratio: expect.any(Number)
          }),
          pages: expect.arrayContaining([
            expect.objectContaining({ slide_number: 1, archetype: 'cover' }),
            expect.objectContaining({
              slide_number: 2,
              item_capacity: expect.any(Number),
              content_density: expect.any(String),
              target_body_text_units_min: expect.any(Number)
            })
          ])
        })
      )
      const originalTemplate = await fs.readFile(templatePath)
      const originalZip = new AdmZip(originalTemplate)

      const result = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: outputPath,
          format: 'pptx',
          pptx_template: { file_path: templatePath, mode: 'edit-copy', target_slide_number: 2 },
          slides: [
            {
              title: 'Revised implementation plan',
              takeaway: 'The source deck stays unchanged',
              bullets: ['Discover', 'Build', 'Validate']
            }
          ],
          render_validation: 'skip'
        }
      })
      expect(result.isError).not.toBe(true)
      const textContent = result.content.find((item) => item.type === 'text')
      const payload = JSON.parse(textContent?.type === 'text' ? textContent.text : '{}')
      expect(payload.pptx_template).toEqual(
        expect.objectContaining({
          mode: 'edit-copy',
          source_slides: 2,
          output_slides: 2,
          edited_slides: [2],
          exact_package_reuse: true
        })
      )
      expect(payload.verification.details).toEqual(
        expect.objectContaining({
          pptx_template_mode: 'edit-copy',
          pptx_template_output_slides: 2,
          pptx_template_exact_package_reuse: true
        })
      )

      const outputZip = new AdmZip(await fs.readFile(outputPath))
      expect(outputZip.readFile('ppt/slides/slide1.xml')).toEqual(originalZip.readFile('ppt/slides/slide1.xml'))
      expect(outputZip.readAsText('ppt/slides/slide2.xml')).toContain('Revised implementation plan')
      expect(await fs.readFile(templatePath)).toEqual(originalTemplate)

      const adaptiveOutputPath = path.join(root, 'adaptive-design.pptx')
      const adaptiveResult = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: adaptiveOutputPath,
          format: 'pptx',
          pptx_template: { file_path: templatePath, mode: 'adaptive-design' },
          slides: [
            { title: 'Adaptive cover', subtitle: 'Visual language without forced geometry', layout: 'cover' },
            {
              title: 'The new story chooses a content-fit composition',
              layout: 'cards',
              takeaway: 'The source remains a design reference',
              bullets: [
                'Inspect: Read the source design language',
                'Plan: Match content semantics',
                'Verify: Render and review'
              ]
            }
          ],
          render_validation: 'skip'
        }
      })
      expect(adaptiveResult.isError).not.toBe(true)
      const adaptiveText = adaptiveResult.content.find((item) => item.type === 'text')
      const adaptivePayload = JSON.parse(adaptiveText?.type === 'text' ? adaptiveText.text : '{}')
      expect(adaptivePayload.pptx_template_strategy).toBe('adaptive-design')
      expect(adaptivePayload.pptx_style_reference).toEqual(
        expect.objectContaining({ source_path: templatePath, design_language: expect.any(Object) })
      )
      expect(adaptivePayload.verification.details).toEqual(
        expect.objectContaining({
          pptx_template_mode: 'adaptive-design',
          pptx_template_exact_package_reuse: false
        })
      )
      expect(await fs.readFile(templatePath)).toEqual(originalTemplate)

      const overwrite = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: templatePath,
          format: 'pptx',
          pptx_template: { file_path: templatePath, mode: 'edit-copy', target_slide_number: 1 },
          slides: [{ title: 'Must not overwrite', bullets: ['Blocked'] }],
          render_validation: 'skip'
        }
      })
      expect(overwrite.isError).toBe(true)
      expect(await fs.readFile(templatePath)).toEqual(originalTemplate)
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('rejects unsafe template inputs and image replacement on a page with no picture shape', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-native-template-root-'))
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-native-template-outside-'))
    tempDirs.push(root, outside)
    const templatePath = path.join(root, 'template.pptx')
    const textTemplatePath = path.join(root, 'template.txt')
    const outsideTemplatePath = path.join(outside, 'outside.pptx')
    const imagePath = path.join(root, 'replacement.png')
    const { assistant, client } = await createClient(root)

    try {
      const templateResult = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: templatePath,
          format: 'pptx',
          slides: [{ title: 'Template cover', layout: 'cover', bullets: ['Native source'] }],
          render_validation: 'skip'
        }
      })
      expect(templateResult.isError).not.toBe(true)
      await fs.copyFile(templatePath, outsideTemplatePath)
      await fs.writeFile(textTemplatePath, 'not a pptx')
      await sharp({
        create: { width: 320, height: 180, channels: 4, background: { r: 32, g: 96, b: 170, alpha: 1 } }
      })
        .png()
        .toFile(imagePath)

      const cases = [
        {
          output: 'unauthorized-output.pptx',
          template: { file_path: outsideTemplatePath, mode: 'edit-copy', target_slide_number: 1 },
          slides: [{ title: 'Blocked source', bullets: ['Outside root'] }]
        },
        {
          output: 'unsupported-output.pptx',
          template: { file_path: textTemplatePath, mode: 'edit-copy', target_slide_number: 1 },
          slides: [{ title: 'Blocked extension', bullets: ['Not PPTX'] }]
        },
        {
          output: 'image-output.pptx',
          template: { file_path: templatePath, mode: 'edit-copy', target_slide_number: 1 },
          slides: [{ title: 'No picture target', bullets: [], image_asset_id: 'hero' }],
          assets: [{ id: 'hero', file_path: imagePath }]
        }
      ]

      for (const testCase of cases) {
        const outputPath = path.join(root, testCase.output)
        const result = await client.callTool({
          name: 'create_file',
          arguments: {
            file_path: outputPath,
            format: 'pptx',
            pptx_template: testCase.template,
            slides: testCase.slides,
            assets: testCase.assets,
            render_validation: 'skip'
          }
        })
        expect(result.isError).toBe(true)
        await expect(fs.stat(outputPath)).rejects.toThrow()
      }
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('replaces a native template main picture through create_file without changing slide geometry', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-native-template-image-'))
    tempDirs.push(root)
    const sourceImagePath = path.join(root, 'source-image.png')
    const replacementImagePath = path.join(root, 'replacement-image.png')
    const templatePath = path.join(root, 'photo-template.pptx')
    const outputPath = path.join(root, 'photo-template-output.pptx')
    await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#39734D' } })
      .png()
      .toFile(sourceImagePath)
    await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#D6A84B' } })
      .png()
      .toFile(replacementImagePath)
    const { assistant, client } = await createClient(root)

    try {
      const template = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: templatePath,
          format: 'pptx',
          title: 'Photo template',
          slides: [{ title: 'Photo template', layout: 'image', bullets: ['Source photo'], image_asset_id: 'source' }],
          assets: [{ id: 'source', file_path: sourceImagePath }],
          render_validation: 'skip'
        }
      })
      expect(template.isError).not.toBe(true)
      const originalTemplate = await fs.readFile(templatePath)
      const originalSlideXml = new AdmZip(originalTemplate).readFile('ppt/slides/slide1.xml')

      const missingReplacement = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: path.join(root, 'blocked-off-topic-photo.pptx'),
          format: 'pptx',
          title: 'New topic without replacement media',
          pptx_template: { file_path: templatePath, mode: 'new-deck' },
          slides: [{ title: 'Changed topic', bullets: ['New content'], template_slide_number: 1 }],
          render_validation: 'skip'
        }
      })
      expect(missingReplacement.isError).toBe(true)
      expect(JSON.stringify(missingReplacement.content)).toContain('retry automatically')

      const result = await client.callTool({
        name: 'create_file',
        arguments: {
          file_path: outputPath,
          format: 'pptx',
          title: 'New-topic photo template',
          pptx_template: { file_path: templatePath, mode: 'new-deck' },
          slides: [
            {
              title: 'Preserve native geometry',
              bullets: [],
              template_slide_number: 1,
              preserve_content: true,
              image_asset_id: 'replacement'
            }
          ],
          assets: [{ id: 'replacement', file_path: replacementImagePath }],
          render_validation: 'skip'
        }
      })
      expect(result.isError).not.toBe(true)
      const output = new AdmZip(await fs.readFile(outputPath))
      expect(output.readFile('ppt/slides/slide1.xml')).toEqual(originalSlideXml)
      expect(output.readAsText('ppt/slides/_rels/slide1.xml.rels')).toContain('../media/zen-ai-template-1.png')
      expect(output.readFile('ppt/media/zen-ai-template-1.png')).toBeTruthy()
      expect(await fs.readFile(templatePath)).toEqual(originalTemplate)
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('runs Python in an authorized working directory', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-python-'))
    tempDirs.push(root)
    mocks.executePython.mockResolvedValue({
      exitCode: 0,
      stdout: '42',
      stderr: '',
      durationMs: 12
    })
    const { assistant, client } = await createClient(root)

    try {
      const result = await client.callTool({
        name: 'python_execute',
        arguments: { code: 'print(6 * 7)', working_directory: root }
      })
      expect(result.isError).not.toBe(true)
      expect(mocks.executePython).toHaveBeenCalledWith('print(6 * 7)', {
        cwd: path.resolve(root),
        timeoutMs: undefined
      })
      expect(result.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('42') })])
      )
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('rejects a parent project cwd, then safely recovers when the model omits working_directory', async () => {
    const project = await fs.mkdtemp(path.join(tmpdir(), 'zen-python-cwd-'))
    tempDirs.push(project)
    const root = path.join(project, 'authorized-workspace')
    await fs.mkdir(root)
    mocks.executePython.mockResolvedValue({ exitCode: 0, stdout: '42', stderr: '', durationMs: 1 })
    const { assistant, client } = await createClient(root, { workspace: root, readNativeSkills: async () => [] })
    try {
      const rejected = await client.callTool({
        name: 'python_execute',
        arguments: { code: 'print(42)', working_directory: project }
      })
      expect(rejected.isError).toBe(true)
      expect(mocks.executePython).not.toHaveBeenCalled()
      const errorText = JSON.stringify(rejected)
      expect(errorText).toContain('Invalid working_directory')
      expect(errorText).toContain('Omit working_directory')
      expect(errorText).toContain('No Python was executed')
      const recovered = await client.callTool({ name: 'python_execute', arguments: { code: 'print(42)' } })
      expect(recovered.isError).not.toBe(true)
      expect(mocks.executePython).toHaveBeenCalledExactlyOnceWith('print(42)', { cwd: root, timeoutMs: undefined })
      const deniedAgain = await client.callTool({
        name: 'python_execute',
        arguments: { code: 'print(42)', working_directory: project }
      })
      expect(deniedAgain.isError).toBe(true)
      expect(mocks.executePython).toHaveBeenCalledTimes(1)
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('does not silently replace a missing cwd with the default workspace', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-python-cwd-missing-'))
    tempDirs.push(root)
    const { assistant, client } = await createClient(root)
    try {
      const result = await client.callTool({
        name: 'python_execute',
        arguments: { code: 'print(42)', working_directory: path.join(root, 'absent') }
      })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).toContain('Omit working_directory')
      expect(mocks.executePython).not.toHaveBeenCalled()
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('uses system OCR for an authorized image', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-ocr-'))
    tempDirs.push(root)
    const imagePath = path.join(root, 'sample.png')
    await fs.writeFile(imagePath, Buffer.from('test-image'))
    mocks.listOcrProviders.mockReturnValue(['system', 'tesseract'])
    mocks.ocr.mockResolvedValue({ text: 'Zen AI OCR result with readable English text.' })
    const { assistant, client } = await createClient(root)

    try {
      const result = await client.callTool({
        name: 'ocr_file',
        arguments: { file_path: imagePath, provider: 'auto', languages: ['en-us'] }
      })
      expect(result.isError).not.toBe(true)
      expect(mocks.ocr).toHaveBeenCalledTimes(1)
      expect(result.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('Zen AI OCR') })])
      )
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('compares system OCR and Tesseract for mixed Chinese and English', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-ocr-bilingual-'))
    tempDirs.push(root)
    const imagePath = path.join(root, 'bilingual.png')
    await fs.writeFile(imagePath, Buffer.from('test-image'))
    mocks.listOcrProviders.mockReturnValue(['system', 'tesseract'])
    mocks.ocr
      .mockResolvedValueOnce({ text: 'System OCR returns readable English and 中文内容。' })
      .mockResolvedValueOnce({ text: 'Tesseract returns readable English and 中文内容。', confidence: 92 })
    const { assistant, client } = await createClient(root)

    try {
      const result = await client.callTool({
        name: 'ocr_file',
        arguments: { file_path: imagePath, provider: 'auto', languages: ['zh-cn', 'en-us'] }
      })

      expect(result.isError).not.toBe(true)
      expect(mocks.ocr).toHaveBeenCalledTimes(2)
      expect(mocks.ocr.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ id: 'system' }))
      expect(mocks.ocr.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ id: 'tesseract' }))
      const textContent = result.content.find((item) => item.type === 'text')
      const payload = JSON.parse(textContent?.type === 'text' ? textContent.text : '{}')
      expect(payload.page_results[0].candidate_count).toBe(2)
      expect(payload.low_confidence_pages).toEqual([])
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('falls back when English words are repeatedly joined together', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-ocr-joined-words-'))
    tempDirs.push(root)
    const imagePath = path.join(root, 'english.png')
    await fs.writeFile(imagePath, Buffer.from('test-image'))
    mocks.listOcrProviders.mockReturnValue(['system', 'tesseract'])
    mocks.ocr
      .mockResolvedValueOnce({
        text: 'The candidate is independentinthe Senate and works forthe public on economic policy.'
      })
      .mockResolvedValueOnce({
        text: 'The candidate is independent in the Senate and works for the public on economic policy.',
        confidence: 93
      })
    const { assistant, client } = await createClient(root)

    try {
      const result = await client.callTool({
        name: 'ocr_file',
        arguments: { file_path: imagePath, provider: 'auto', languages: ['en-us'] }
      })

      expect(result.isError).not.toBe(true)
      expect(mocks.ocr).toHaveBeenCalledTimes(2)
      const textContent = result.content.find((item) => item.type === 'text')
      const payload = JSON.parse(textContent?.type === 'text' ? textContent.text : '{}')
      expect(payload.providers).toEqual(['tesseract'])
      expect(payload.text).toContain('independent in the Senate')
      expect(payload.page_results[0].engine_confidence).toBe(93)
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('prefers Simplified Chinese when the request does not include Traditional Chinese', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-ocr-simplified-'))
    tempDirs.push(root)
    const imagePath = path.join(root, 'simplified.png')
    await fs.writeFile(imagePath, Buffer.from('test-image'))
    mocks.listOcrProviders.mockReturnValue(['system', 'tesseract'])
    mocks.ocr
      .mockResolvedValueOnce({ text: '這是一份與財務、學習和實際業務有關的 English 報告。' })
      .mockResolvedValueOnce({ text: '这是一份与财务、学习和实际业务有关的 English 报告。', confidence: 88 })
    const { assistant, client } = await createClient(root)

    try {
      const result = await client.callTool({
        name: 'ocr_file',
        arguments: { file_path: imagePath, provider: 'auto', languages: ['zh-cn', 'en-us'] }
      })

      expect(result.isError).not.toBe(true)
      const textContent = result.content.find((item) => item.type === 'text')
      const payload = JSON.parse(textContent?.type === 'text' ? textContent.text : '{}')
      expect(payload.providers).toEqual(['tesseract'])
      expect(payload.text).toContain('这是一份与财务、学习和实际业务有关的')
      expect(payload.text).not.toContain('這是一份與財務')
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('retries weak auto OCR once with high-contrast preprocessing', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-ocr-contrast-'))
    tempDirs.push(root)
    const imagePath = path.join(root, 'faint.png')
    await fs.writeFile(imagePath, Buffer.from('test-image'))
    mocks.listOcrProviders.mockReturnValue(['system', 'tesseract'])
    mocks.ocr.mockResolvedValueOnce({ text: 'weak' }).mockResolvedValueOnce({ text: 'faint' }).mockResolvedValueOnce({
      text: 'High contrast recovers a complete English sentence and 清晰的简体中文段落。',
      confidence: 90
    })
    const { assistant, client } = await createClient(root)

    try {
      const result = await client.callTool({
        name: 'ocr_file',
        arguments: { file_path: imagePath, provider: 'auto' }
      })

      expect(result.isError).not.toBe(true)
      expect(mocks.ocr).toHaveBeenCalledTimes(3)
      expect(mocks.ocr.mock.calls[2]?.[1]).toEqual(
        expect.objectContaining({
          id: 'tesseract',
          config: expect.objectContaining({ preprocess: 'high-contrast' })
        })
      )
      const textContent = result.content.find((item) => item.type === 'text')
      const payload = JSON.parse(textContent?.type === 'text' ? textContent.text : '{}')
      expect(payload.status).toBe('completed')
      expect(payload.providers).toEqual(['tesseract-high-contrast'])
      expect(payload.page_results[0]).toEqual(expect.objectContaining({ candidate_count: 3, low_confidence: false }))
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('preserves Tesseract paragraph boundaries in text output', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-ocr-paragraphs-'))
    tempDirs.push(root)
    const imagePath = path.join(root, 'paragraphs.png')
    const outputPath = path.join(root, 'paragraphs.txt')
    await fs.writeFile(imagePath, Buffer.from('test-image'))
    mocks.listOcrProviders.mockReturnValue(['tesseract'])
    mocks.ocr.mockResolvedValue({
      text: 'First line\nSecond line\nNew paragraph',
      confidence: 91,
      lines: [
        { text: 'First line', paragraph: 0 },
        { text: 'Second line', paragraph: 0 },
        { text: 'New paragraph', paragraph: 1 }
      ]
    })
    const { assistant, client } = await createClient(root)

    try {
      const result = await client.callTool({
        name: 'ocr_file',
        arguments: {
          file_path: imagePath,
          provider: 'tesseract',
          languages: ['en-us'],
          output_path: outputPath
        }
      })

      expect(result.isError).not.toBe(true)
      expect(await fs.readFile(outputPath, 'utf8')).toBe('First line\nSecond line\n\nNew paragraph')
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('falls back to better multiline OCR when the system result loses bilingual layout', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-ocr-quality-'))
    tempDirs.push(root)
    const imagePath = path.join(root, 'bilingual.png')
    const outputPath = path.join(root, 'bilingual.txt')
    await fs.writeFile(imagePath, Buffer.from('test-image'))
    const lowQualitySystemText = `${'中 文 识 别 结 果 缺 少 段 落 。 '.repeat(24)}${'State Senator text is flattened into one line. '.repeat(12)}`
    const betterTesseractText = [
      'State Senator Rick Bennett is an independent candidate in Maine.',
      'Several donors and strategists support his campaign.',
      '',
      '缅因州独立州长候选人里克·贝内特得到了多位捐助者和策略师的支持。',
      '这段中文与英文应当保留各自的阅读顺序和段落。'
    ].join('\n')
    mocks.listOcrProviders.mockReturnValue(['system', 'tesseract'])
    mocks.ocr.mockResolvedValueOnce({ text: lowQualitySystemText }).mockResolvedValueOnce({ text: betterTesseractText })
    const { assistant, client } = await createClient(root)

    try {
      const result = await client.callTool({
        name: 'ocr_file',
        arguments: { file_path: imagePath, provider: 'auto', output_path: outputPath }
      })
      expect(result.isError).not.toBe(true)
      expect(mocks.ocr).toHaveBeenCalledTimes(2)
      expect(mocks.ocr.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ id: 'system' }))
      expect(mocks.ocr.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ id: 'tesseract' }))

      const output = await fs.readFile(outputPath, 'utf8')
      expect(output).toBe(betterTesseractText)
      expect(output).toContain('\n\n缅因州')
      expect(result.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('tesseract') })])
      )
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('keeps a usable normalized system OCR result when the quality fallback fails', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-ocr-recovery-'))
    tempDirs.push(root)
    const imagePath = path.join(root, 'fallback.png')
    const outputPath = path.join(root, 'fallback.txt')
    await fs.writeFile(imagePath, Buffer.from('test-image'))
    const systemText = `${'中 文 内 容 虽 然 有 空 格 但 仍 可 使 用 。 '.repeat(24)}${'Long English text remains available. '.repeat(10)}`
    mocks.listOcrProviders.mockReturnValue(['system', 'tesseract'])
    mocks.ocr.mockResolvedValueOnce({ text: systemText }).mockRejectedValueOnce(new Error('Tesseract unavailable'))
    const { assistant, client } = await createClient(root)

    try {
      const result = await client.callTool({
        name: 'ocr_file',
        arguments: { file_path: imagePath, provider: 'auto', output_path: outputPath }
      })
      expect(result.isError).not.toBe(true)
      expect(mocks.ocr).toHaveBeenCalledTimes(3)

      const output = await fs.readFile(outputPath, 'utf8')
      expect(output).toContain('中文内容虽然有空格但仍可使用。')
      expect(output).not.toContain('中 文 内 容')
      expect(result.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('system') })])
      )
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('runs an authorized bundled Python script with explicit arguments', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-script-'))
    tempDirs.push(root)
    const scriptPath = path.join(root, 'validate.py')
    await fs.writeFile(scriptPath, 'print("ok")', 'utf8')
    mocks.executePythonScript.mockResolvedValue({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 8
    })
    const { assistant, client } = await createClient(root)

    try {
      const result = await client.callTool({
        name: 'python_execute',
        arguments: { script_path: scriptPath, arguments: ['output.pptx'] }
      })
      expect(result.isError).not.toBe(true)
      expect(mocks.executePythonScript).toHaveBeenCalledWith(scriptPath, ['output.pptx'], {
        cwd: root,
        timeoutMs: undefined
      })
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })

  it('renders and OCRs selected PDF pages in order', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'zen-assistant-pdf-ocr-'))
    tempDirs.push(root)
    const pdfPath = path.join(root, 'scan.pdf')
    const outputPath = path.join(root, 'scan.txt')
    const pdf = await PDFDocument.create()
    pdf.addPage([320, 240])
    pdf.addPage([320, 240])
    await fs.writeFile(pdfPath, await pdf.save())
    mocks.listOcrProviders.mockReturnValue(['system'])
    mocks.ocr.mockResolvedValueOnce({ text: '第一页' }).mockResolvedValueOnce({ text: '第二页' })
    const { assistant, client } = await createClient(root)

    try {
      const result = await client.callTool({
        name: 'ocr_file',
        arguments: { file_path: pdfPath, pages: [1, 2], max_pages: 2, output_path: outputPath }
      })
      expect(result.isError).not.toBe(true)
      expect(mocks.ocr).toHaveBeenCalledTimes(2)
      const output = await fs.readFile(outputPath, 'utf8')
      expect(output).toContain('===== Page 1 =====')
      expect(output).toContain('===== Page 2 =====')
      expect(output).not.toContain('## Page')
      expect(result.content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('## Page 2') })])
      )
    } finally {
      await client.close()
      await assistant.mcpServer.close()
    }
  })
})
