import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import AdmZip from 'adm-zip'
import { PDFDocument, PDFName } from 'pdf-lib'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { offlineEnvironment } from '../../../../scripts/quality/process'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('node:os')
vi.unmock('node:path')

import { readAssistantPdf } from '../assistantDocumentPdf'
import { runDocumentWorker } from '../assistantDocumentWorker'

const temporary: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function largePdf(withText = false) {
  // Same 9.9 MB uncompressed-stream case as the native attachment smoke.
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const contents = pdf.context.stream(' '.repeat(9_900_000 - 4) + 'q\nQ\n')
  page.node.set(PDFName.of('Contents'), pdf.context.register(contents))
  if (withText) pdf.addPage([612, 792]).drawText('Owned PDF amount 12345', { x: 40, y: 700 })
  return Buffer.from(await pdf.save({ useObjectStreams: false }))
}

describe('isolated document parsers', () => {
  it('waits for worker cleanup instead of terminating as soon as a result is posted', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'zen-document-cleanup-'))
    temporary.push(directory)
    const marker = path.join(directory, 'cleanup-complete.txt')
    const result = await runDocumentWorker(
      `const { parentPort, workerData } = require('node:worker_threads');
       parentPort.postMessage({ ok: true });
       setTimeout(() => require('node:fs').writeFileSync(workerData.marker, 'closed'), 50);`,
      { marker },
      'Test'
    )
    expect(result).toEqual({ ok: true })
    expect(await fs.readFile(marker, 'utf8')).toBe('closed')
  })

  it('does not accept a result followed by an abnormal worker exit', async () => {
    await expect(
      runDocumentWorker(
        `require('node:worker_threads').parentPort.postMessage({ ok: true }); process.exit(7);`,
        {},
        'Test'
      )
    ).rejects.toThrow('exit 7')
  })

  it('still allows cancellation after a result when the worker has not exited', async () => {
    const controller = new AbortController()
    const pending = runDocumentWorker(
      `require('node:worker_threads').parentPort.postMessage({ ok: true }); setInterval(() => {}, 1000);`,
      {},
      'Test',
      controller.signal
    )
    const failed = expect(pending).rejects.toThrow('cancelled')
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    await failed
  })

  it('terminates unresponsive worker code at the deadline without blocking the main thread', async () => {
    vi.useFakeTimers()
    const pending = runDocumentWorker('while (true) {}', {}, 'Test')
    const failed = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15_000)
    await failed
  })

  it('terminates running parser work on cancellation and reports worker crashes', async () => {
    const controller = new AbortController()
    const pending = runDocumentWorker('while (true) {}', {}, 'Test', controller.signal)
    const failed = expect(pending).rejects.toThrow('cancelled')
    controller.abort()
    await failed
    await expect(runDocumentWorker('throw new Error("corrupt input")', {}, 'Test')).rejects.toThrow('corrupt input')
    await expect(runDocumentWorker('process.exit(0)', {}, 'Test')).rejects.toThrow('parser stopped')
  })

  it('handles the 9.9 MB PDF stream without returning raw PDF or base64', async () => {
    const data = await largePdf()
    expect(data.length).toBeGreaterThan(9_900_000)
    const result = await readAssistantPdf(data, 1, 1)
    expect(result.total).toBe(1)
    expect(result.sections).toEqual([{ text: '', metadata: { page: 1 } }])
    expect(JSON.stringify(result).length).toBeLessThan(200)
  })

  const executable = path.resolve('dist/win-unpacked/Zen AI.exe')
  const archive = path.resolve('dist/win-unpacked/resources/app.asar')
  it.skipIf(!existsSync(executable) || !existsSync(archive))(
    'runs production-transformed Office workers and PDF processes using real Electron and app.asar dependencies',
    async () => {
      const directory = await fs.mkdtemp(path.join(tmpdir(), 'zen-document-asar-'))
      temporary.push(directory)
      const { rolldown } = await import(
        pathToFileURL(require.resolve('rolldown', { paths: [require.resolve('electron-vite')] })).href
      )
      const archivePackage = path.join(archive, 'package.json')
      // Same bundler as the production main build; minification additionally
      // catches accidentally-hoisted closure references in factory.toString().
      for (const [name, entry] of Object.entries({ office: 'assistantDocumentOffice', pdf: 'assistantDocumentPdf' })) {
        const build = await rolldown({
          input: path.resolve(`src/main/mcpServers/${entry}.ts`),
          platform: 'node',
          external: (id: string) => id.startsWith('node:')
        })
        try {
          await build.write({
            file: path.join(directory, `${name}.cjs`),
            format: 'cjs',
            minify: true,
            inlineDynamicImports: true
          })
        } finally {
          await build.close()
        }
      }
      const pdfPath = path.join(directory, 'large.pdf')
      const docxPath = path.join(directory, 'report.docx')
      await fs.writeFile(pdfPath, await largePdf(true))
      const zip = new AdmZip()
      zip.addFile(
        'word/document.xml',
        Buffer.from('<w:document xmlns:w="w"><w:p><w:r><w:t>ASAR worker text</w:t></w:r></w:p></w:document>')
      )
      await fs.writeFile(docxPath, zip.toBuffer())
      const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const Module = require('node:module');
      const req = Module.createRequire(${JSON.stringify(archivePackage)});
      function load(name) {
        const filename = path.join(${JSON.stringify(archive)}, 'out', 'main', name + '.cjs');
        const loaded = new Module(filename, module);
        loaded.filename = filename;
        loaded.paths = Module._nodeModulePaths(path.dirname(filename));
        loaded._compile(fs.readFileSync(path.join(${JSON.stringify(directory)}, name + '.cjs'), 'utf8'), filename);
        return loaded.exports;
      }
      process.stderr.write('phase:load-readers\\n');
      const readers = { pdf: load('pdf'), office: load('office') };
      process.stderr.write('phase:readers-loaded\\n');
      (async () => {
        const batches = [];
        for (let iteration = 0; iteration < 10; iteration++) {
          process.stderr.write('phase:batch-' + iteration + '\\n');
          const [pdf, office] = await Promise.all([
            readers.pdf.readAssistantPdf(fs.readFileSync(${JSON.stringify(pdfPath)}), 1, 2).then(result => { process.stderr.write('phase:pdf-done\\n'); return result }),
            readers.office.readAssistantOffice(fs.readFileSync(${JSON.stringify(docxPath)}), 'docx').then(result => { process.stderr.write('phase:office-done\\n'); return result })
          ]);
          batches.push({ pdf, office });
        }
        process.stdout.write(JSON.stringify({ batches, pdfModule: req.resolve('pdf-parse'), electron: process.versions.electron }));
      })()
        .catch(error => { process.stderr.write(error.stack); process.exitCode = 1 });
    `
      for (let launch = 0; launch < 3; launch++) {
        let stdout: string
        try {
          ;({ stdout } = await promisify(execFile)(executable, ['-e', script], {
            env: { ...offlineEnvironment(process.env), ELECTRON_RUN_AS_NODE: '1' },
            windowsHide: true,
            timeout: 25_000,
            maxBuffer: 200_000
          }))
        } catch (error) {
          const details = error as Error & { code?: number; signal?: string; stdout?: string; stderr?: string }
          throw new Error(
            `Packaged document workers failed on launch ${launch + 1}: exit=${details.code}, signal=${details.signal}; stdout=${details.stdout?.slice(-2000)}; stderr=${details.stderr?.slice(-2000)}`,
            { cause: error }
          )
        }
        const result = JSON.parse(stdout)
        expect(result.electron).toBeTruthy()
        expect(result.pdfModule).toContain('app.asar')
        expect(result.batches).toHaveLength(10)
        for (const batch of result.batches) {
          expect(batch.pdf.total).toBe(2)
          expect(batch.pdf.sections[1].text).toContain('Owned PDF amount 12345')
          expect(batch.office.sections[0].text).toBe('ASAR worker text')
        }
      }
    },
    90_000
  )
})
