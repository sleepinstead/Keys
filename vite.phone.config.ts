import { defineConfig } from 'vite';

// The iPhone web app: static files only, deployable anywhere with HTTPS (e.g. GitHub Pages).
export default defineConfig({
  root: 'phone',
  base: './',
  envDir: '..',
  cacheDir: '../node_modules/.vite-phone', // its own: sharing the desktop dev server's cache breaks it
  server: { host: 'localhost', port: 5180, strictPort: true },
  worker: { format: 'es' },
  build: { outDir: '../dist-phone', emptyOutDir: true, sourcemap: false },
});
