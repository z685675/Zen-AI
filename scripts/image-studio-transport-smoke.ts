import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { build } from 'vite'

async function main() {
  mkdirSync(resolve('tmp'), { recursive: true })
  const directory = mkdtempSync(resolve('tmp/image-studio-transport-'))
  const data = mkdtempSync(resolve(tmpdir(), 'zen-image-transport-'))
  await build({
    configFile: false,
    plugins: [
      {
        name: 'smoke-logger',
        resolveId(id) {
          if (id === '@logger') return '\0smoke-logger'
          if (id.startsWith('@shared/')) return resolve('packages/shared', `${id.slice(8)}.ts`)
          return null
        },
        load(id) {
          if (id === '\0smoke-logger')
            return 'export const loggerService = { withContext: () => ({ info: () => {}, warn: (_, evidence) => process.stderr.write(JSON.stringify(evidence) + "\\n"), error: () => {} }) }'
          return null
        }
      }
    ],
    resolve: { alias: { '@shared': resolve('packages/shared') } },
    build: {
      outDir: directory,
      minify: false,
      lib: {
        entry: resolve('scripts/fixtures/image-studio-transport.ts'),
        formats: ['cjs'],
        fileName: () => 'entry.cjs'
      },
      rollupOptions: {
        external: (id) => id.startsWith('node:') || ['electron', 'sharp'].includes(id),
        output: { inlineDynamicImports: true }
      }
    }
  })
  const electron = (await import('electron')).default as unknown as string
  const env: NodeJS.ProcessEnv = { ...process.env, IMAGE_SMOKE_USER_DATA: data }
  delete env.ELECTRON_RUN_AS_NODE
  process.exitCode = await new Promise<number>((done, reject) => {
    const child = spawn(electron, [resolve(directory, 'entry.cjs')], { env, stdio: 'inherit', windowsHide: true })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Electron transport smoke timed out'))
    }, 30000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      done(code ?? 1)
    })
  })
}
void main().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
