import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** public/design holds source artwork (large PNGs, the .icns): kept in the repo, left out of the app. */
function dropDesignFiles(): Plugin {
  let outDir = 'dist';
  return {
    name: 'keys:drop-design-files',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      fs.rmSync(path.join(outDir, 'design'), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), dropDesignFiles()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:5174' } },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
