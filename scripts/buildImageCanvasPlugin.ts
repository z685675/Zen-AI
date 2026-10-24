import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

import { build, type Plugin } from 'vite'

export function buildImageCanvasPlugin(root: string): Plugin {
  return {
    name: 'zen-bundled-image-canvas',
    apply: 'build',
    buildStart() {
      execSync('pnpm --filter @zen-ai/image-canvas build', { cwd: root, stdio: 'inherit', windowsHide: true })
      execSync('pnpm --filter @zen-ai/image-workbench build', { cwd: root, stdio: 'inherit', windowsHide: true })
    }
  }
}

export function buildImageCanvasPreloadPlugin(root: string): Plugin {
  return {
    name: 'zen-image-canvas-preload',
    apply: 'build',
    async closeBundle() {
      // Sandboxed Electron preloads cannot import a shared ESM chunk. Build this
      // minimal bridge independently so it only requires Electron's built-in API.
      await build({
        configFile: false,
        resolve: { alias: { '@shared': resolve(root, 'packages/shared') } },
        build: {
          outDir: resolve(root, 'out/preload'),
          emptyOutDir: false,
          target: 'node22',
          lib: {
            entry: resolve(root, 'src/preload/imageCanvas.ts'),
            formats: ['cjs'],
            fileName: () => 'imageCanvas.js'
          },
          rollupOptions: { external: ['electron'] },
          minify: false
        }
      })
    }
  }
}
