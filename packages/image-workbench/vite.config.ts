import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
export default defineConfig({
  root,
  base: './',
  resolve: { alias: { '@shared': resolve(root, '../shared') } },
  esbuild: { jsx: 'automatic' },
  build: { outDir: resolve(root, '../../resources/image-workbench'), emptyOutDir: true },
  plugins: [
    {
      name: 'workbench-attribution',
      closeBundle() {
        copyFileSync(resolve(root, 'LICENSE-DSH'), resolve(root, '../../resources/image-workbench/LICENSE-DSH.txt'))
        copyFileSync(resolve(root, 'UPSTREAM.md'), resolve(root, '../../resources/image-workbench/UPSTREAM.txt'))
        copyFileSync(
          resolve(root, '../../src/renderer/src/assets/fonts/harmonyos/LICENSE.txt'),
          resolve(root, '../../resources/image-workbench/HarmonyOS-font-LICENSE.txt')
        )
      }
    }
  ]
})
