import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.KEYS_PORT ?? 5174);
const host = '127.0.0.1'; // never listen on external interfaces
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
if (!production) origins.push('http://localhost:5173', 'http://127.0.0.1:5173'); // Vite dev server

const { app, storage, sessions } = createApp({
  allowedOrigins: origins,
  staticDir: production ? path.join(root, 'dist') : undefined,
  appUrl: production ? `http://localhost:${port}` : 'http://localhost:5173',
});

const server = app.listen(port, host, () => {
  // In dev, Vite prints the address to open.
  if (production) console.log(`Keys: http://localhost:${port}`);
  const where = storage.info();
  if (!where.available) console.warn(`Database unavailable: ${where.error}`);
});

function shutdown() {
  sessions.dispose(); // wipes the in-memory key
  server.close(() => {
    storage.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
