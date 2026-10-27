// Local Electron + real CDP acceptance. No upstream, user profile or website actions.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { build } from 'vite'

async function main() {
  const directory = mkdtempSync(resolve('tmp/browser-click-'))
  const data = mkdtempSync(resolve(tmpdir(), 'zen-browser-click-'))
  await build({
    configFile: false,
    plugins: [
      {
        name: 'isolated-browser-smoke',
        resolveId(id) {
          return ['@logger', '@main/config', '@main/constant'].includes(id) ? '\0smoke:' + id : null
        },
        load(id) {
          if (id === '\0smoke:@logger')
            return 'const logger = Object.fromEntries(["debug","info","warn","error","silly","verbose"].map(k => [k, () => {}])); export const loggerService = { ...logger, withContext: () => logger };'
          if (id === '\0smoke:@main/config')
            return 'export const titleBarOverlayDark = {height:42,color:"#111",symbolColor:"#fff"}; export const titleBarOverlayLight = {height:42,color:"#fff",symbolColor:"#111"};'
          if (id === '\0smoke:@main/constant') return 'export const isMac = false;'
          return null
        }
      }
    ],
    build: {
      outDir: directory,
      minify: false,
      lib: {
        entry: resolve('scripts/fixtures/assistant-browser-click.ts'),
        formats: ['cjs'],
        fileName: () => 'entry.cjs'
      },
      rollupOptions: {
        external: (id) => id.startsWith('node:') || ['electron', 'crypto'].includes(id),
        output: { inlineDynamicImports: true }
      }
    }
  })
  const electron = (await import('electron')).default as unknown as string
  const env: NodeJS.ProcessEnv = { ...process.env, BROWSER_CLICK_SMOKE_DATA: data }
  delete env.ELECTRON_RUN_AS_NODE
  process.exitCode = await new Promise<number>((done, reject) => {
    const child = spawn(electron, [resolve(directory, 'entry.cjs')], { env, stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Browser click smoke timed out'))
    }, 30000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      done(code ?? 1)
    })
  })
}
void main().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
