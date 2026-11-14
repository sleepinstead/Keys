import { defineConfig } from 'vite';

// The iPhone web app: static files only, deployable anywhere with HTTPS (e.g. GitHub Pages).
export default defineConfig({
  root: 'phone',
  base: './',
  envDir: '..',
  server: { host: 'localhost', port: 5180, strictPort: true },
  build: { outDir: '../dist-phone', emptyOutDir: true, sourcemap: false },
});
