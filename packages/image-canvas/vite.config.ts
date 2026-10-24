import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
    root,
    base: './',
    plugins: [react(), { name: 'canvas-license', closeBundle() {
        copyFileSync(resolve(root, 'LICENSE'), resolve(root, '../../resources/image-canvas/THIRD-PARTY-LICENSE.txt'));
        copyFileSync(resolve(root, '../../src/renderer/src/assets/fonts/harmonyos/LICENSE.txt'), resolve(root, '../../resources/image-canvas/HarmonyOS-font-LICENSE.txt'));
    } }],
    resolve: { alias: { '@': resolve(root, 'src') } },
    define: { __APP_VERSION__: JSON.stringify('0.20.0 (Zen-AI)'), __APP_CHANGELOG__: JSON.stringify('') },
    build: { outDir: resolve(root, '../../resources/image-canvas'), emptyOutDir: true, chunkSizeWarningLimit: 2500 },
    server: { host: '127.0.0.1', port: 4190, strictPort: true }
});
